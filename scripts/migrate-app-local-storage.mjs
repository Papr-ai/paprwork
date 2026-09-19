#!/usr/bin/env node
/**
 * Copy each mini-app's `localStorage` from the old shared origin into its own
 * isolated origin.
 *
 * Before Enhancement 115 every app ran at `http://localhost:<gateway>`, so all
 * of them — and, in a packaged build, the Paprwork shell too — shared one
 * storage area. After isolation an app runs at `http://app-<id>.localhost:<gw>`
 * and sees an empty store. This moves each app's own keys across.
 *
 * Scoped, never copy-all. On a real machine 72% of the bytes on the shared
 * origin belong to the shell, not to any app (the cloud-sync snapshot alone is
 * ~2.5MB). Copying everything into every app origin would hand each app a
 * readable copy of the user's workspace state and multiply the bytes by the
 * number of apps. So a key moves only to the apps whose source claims it.
 *
 * A copy, not a move. The shared origin is left intact and becomes the backup
 * of record — once isolated no app can reach it anyway, so leaving it costs
 * nothing and makes the operation reversible.
 *
 * A colliding key goes to every claimant. `ds-theme` is written by both
 * Leadership Sync forks, so on the shared origin one value already overwrote
 * the other. Both start from that surviving value and diverge correctly from
 * there. There is nothing to split: the merge already happened, destructively.
 *
 *   node scripts/migrate-app-local-storage.mjs                      # dry run, all apps
 *   node scripts/migrate-app-local-storage.mjs --app "Leadership"   # dry run, one app
 *   node scripts/migrate-app-local-storage.mjs --app "Leadership" --apply
 *
 * Requires the app running with PAPR_PLATFORM_EMBEDDED_CDP=1 and
 * PAPR_PLATFORM_CDP_PORT set (9222 is usually taken by Chrome, and Chromium
 * does not warn when the port is bound — it simply does not listen).
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

import { auditApp, isPlatformKey } from "./audit-app-browser-storage.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const cdpPort = Number(flag("cdp-port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const gatewayPort = Number(flag("gateway-port", process.env.PAPR_GATEWAY_PORT || 18789));
const apply = has("apply");
const appFilter = flag("app");

// Mirrors src/core/miniApps/miniAppOrigin.ts. Restated rather than imported
// because that module is TypeScript and this runs under bare node; the label
// rule itself is pinned by a test on the TS side.
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?$/;
const isolatedOrigin = (appId) =>
  DNS_LABEL.test(appId.trim().toLowerCase())
    ? `http://app-${appId.trim().toLowerCase()}.localhost:${gatewayPort}`
    : null;

const sharedOrigin = `http://localhost:${gatewayPort}`;

// ---------------------------------------------------------------- CDP client

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => (ws.once("open", resolve), ws.once("error", reject)));
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

const listTargets = async () =>
  (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json());

/**
 * Run `fn` inside a frame at `origin`, creating one if none exists.
 *
 * The obvious primitives do not work here. `DOMStorage.getDOMStorageItems`
 * fails with "Frame not found for the given storage id" unless a frame is
 * already live at that origin — and after isolation the old shared origin has
 * none, which is the whole reason this script exists. `Target.createTarget` is
 * "Not supported" in Electron. So the frame is made the only way available:
 * ask a page we can already reach to append a hidden iframe, then attach to
 * the resulting out-of-process target directly. CDP attaches below the
 * same-origin policy, so the parent never gets to read the child.
 */
async function withOriginFrame(host, origin, fn) {
  const src = `${origin}/health`;
  const tag = `__papr_mig_${Math.random().toString(36).slice(2, 10)}`;
  await host.send("Runtime.evaluate", {
    expression: `(()=>{const f=document.createElement('iframe');f.id=${JSON.stringify(tag)};
      f.style.cssText='position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      f.src=${JSON.stringify(src)};document.body.appendChild(f);})()`,
  });
  try {
    const deadline = Date.now() + 8000;
    let target = null;
    while (Date.now() < deadline && !target) {
      await new Promise((r) => setTimeout(r, 150));
      const targets = await listTargets();
      // Prefer the frame we just made over an app frame the user has open, so
      // a running app is never scripted underneath the user.
      target =
        targets.find((t) => t.url === src) ??
        targets.find((t) => t.type === "iframe" && t.url.startsWith(`${origin}/`));
    }
    if (!target) throw new Error(`could not materialise a frame at ${origin}`);
    const frame = await attach(target.webSocketDebuggerUrl);
    try {
      return await fn(frame);
    } finally {
      frame.close();
    }
  } finally {
    await host
      .send("Runtime.evaluate", {
        expression: `document.getElementById(${JSON.stringify(tag)})?.remove()`,
      })
      .catch(() => {
        /* Losing the host mid-run is not worth masking the real error with. */
      });
  }
}

async function evaluate(frame, expression) {
  const res = await frame.send("Runtime.evaluate", { expression, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? "evaluation failed");
  }
  return res.result?.value;
}

const readStore = (frame) =>
  evaluate(frame, "JSON.stringify(Object.fromEntries(Object.entries(localStorage)))").then((s) =>
    new Map(Object.entries(JSON.parse(s))),
  );

// -------------------------------------------------------------- attribution

/**
 * A stored key belongs to an app if the app claims it exactly, or claims a
 * prefix of it. Prefixes exist because `vc-photo-${slug}` cannot be recovered
 * as a literal from source — only its head can.
 */
const claimsKey = (app, key) =>
  app.exactKeys.includes(key) || app.keyPrefixes.some((p) => key.startsWith(p));

function appsRoot() {
  const explicit = flag("root");
  if (explicit) return path.resolve(explicit.replace(/^~/, homedir()));
  const home = process.env.PAPR_HOME || path.join(homedir(), "Papr");
  const orgs = path.join(home, "orgs");
  if (existsSync(orgs)) {
    for (const org of readdirSync(orgs)) {
      const ns = path.join(orgs, org, "namespaces");
      if (!existsSync(ns)) continue;
      for (const n of readdirSync(ns)) {
        const apps = path.join(ns, n, "apps");
        if (existsSync(apps)) return apps;
      }
    }
  }
  return path.join(home, "apps");
}

// -------------------------------------------------------------------- driver

const root = appsRoot();
if (!existsSync(root)) {
  console.error(`no app root at ${root}`);
  process.exit(1);
}

// Every storage-using app is audited even when --app narrows what we act on:
// the "claimed by nobody" report is only true if attribution considered all of
// them, and a filtered run would otherwise call every other app's keys orphaned.
const allApps = readdirSync(root)
  .map((n) => path.join(root, n))
  .filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  })
  .map(auditApp)
  .filter((a) => a.exactKeys.length || a.keyPrefixes.length);

const apps = allApps.filter((a) =>
  appFilter ? a.title.toLowerCase().includes(appFilter.toLowerCase()) || a.id === appFilter : true,
);

if (!apps.length) {
  console.error(
    appFilter ? `no storage-using app matches "${appFilter}"` : "no app uses localStorage",
  );
  process.exit(1);
}

let targets;
try {
  targets = await listTargets();
} catch {
  console.error(
    `No CDP endpoint on ${cdpPort}. Start the app with PAPR_PLATFORM_EMBEDDED_CDP=1 ` +
      `and PAPR_PLATFORM_CDP_PORT=${cdpPort}.`,
  );
  process.exit(1);
}
const hostTarget = targets.find((t) => t.type === "page");
if (!hostTarget) {
  console.error("No page target — is the app window open?");
  process.exit(1);
}
const host = await attach(hostTarget.webSocketDebuggerUrl);

const shared = await withOriginFrame(host, sharedOrigin, readStore);
if (shared.size === 0) {
  console.log(`Shared origin ${sharedOrigin} is empty — nothing to migrate.`);
  host.close();
  process.exit(0);
}

const platformKeys = [...shared.keys()].filter(isPlatformKey);
const totalKb = [...shared].reduce((n, [k, v]) => n + k.length + (v?.length ?? 0), 0) / 1024;
console.log(`Shared origin: ${shared.size} keys, ${totalKb.toFixed(0)}KB`);
console.log(`  ${platformKeys.length} are Paprwork shell keys and are never copied into an app.\n`);

if (apply) {
  const dir = path.join(homedir(), ".paprwork-v2", "storage-backups");
  mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `shared-origin-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(file, JSON.stringify(Object.fromEntries(shared), null, 2));
  console.log(`Backup written: ${file}\n`);
}

const unclaimed = new Set(
  [...shared.keys()].filter(
    (k) => !isPlatformKey(k) && !allApps.some((app) => claimsKey(app, k)),
  ),
);
let migrated = 0;

for (const app of apps.sort((a, b) => a.title.localeCompare(b.title))) {
  const origin = isolatedOrigin(app.id);
  if (!origin) {
    console.log(`SKIP  ${app.title} — id "${app.id}" is not a valid DNS label, so it has no isolated origin.`);
    continue;
  }

  const mine = [...shared].filter(([k]) => !isPlatformKey(k) && claimsKey(app, k));
  const label = `${app.title} (${app.id.slice(0, 8)})`;
  if (!mine.length) {
    const claimed = app.exactKeys.length + app.keyPrefixes.length;
    console.log(`—     ${label}: claims ${claimed} key(s), none of them stored`);
    continue;
  }
  const kb = mine.reduce((n, [k, v]) => n + k.length + (v?.length ?? 0), 0) / 1024;

  const result = await withOriginFrame(host, origin, async (frame) => {
    const before = await readStore(frame);
    if (!apply) {
      return {
        identical: mine.filter(([k, v]) => before.get(k) === v).length,
        conflicting: mine.filter(([k, v]) => before.has(k) && before.get(k) !== v).length,
      };
    }
    const payload = JSON.stringify(Object.fromEntries(mine));
    const report = await evaluate(
      frame,
      `(()=>{const d=JSON.parse(${JSON.stringify(payload)});const failed=[];
        for(const [k,v] of Object.entries(d)){try{localStorage.setItem(k,v);}catch(e){failed.push(k+': '+e.name);}}
        const ok=Object.entries(d).filter(([k,v])=>localStorage.getItem(k)===v).length;
        return JSON.stringify({ok,failed});})()`,
    );
    return JSON.parse(report);
  });

  if (!apply) {
    console.log(
      `DRY   ${label}: ${mine.length} keys, ${kb.toFixed(1)}KB → ${origin}` +
        (result.identical ? `  [${result.identical} already identical]` : "") +
        (result.conflicting ? `  [${result.conflicting} would OVERWRITE a different value]` : ""),
    );
    for (const [k, v] of mine) {
      console.log(`         ${((v?.length ?? 0) / 1024).toFixed(1).padStart(7)}KB  ${k}`);
    }
    continue;
  }

  migrated += result.ok;
  console.log(
    `${result.ok === mine.length ? "OK   " : "PART "} ${label}: ${result.ok}/${mine.length} keys verified (${kb.toFixed(1)}KB)`,
  );
  for (const f of result.failed ?? []) console.log(`         FAILED ${f}`);
}

if (unclaimed.size) {
  console.log(`\n${unclaimed.size} app-looking key(s) claimed by no installed app, left where they are:`);
  for (const k of [...unclaimed].sort()) console.log(`    ${k}`);
  console.log(`  Typically an uninstalled app, or a key built entirely at runtime.`);
}

console.log(
  apply
    ? `\nMigrated ${migrated} keys. Shared origin left intact as the backup of record.\n` +
        `Reload any app that was open — it read its (empty) store before this ran.`
    : `\nDry run — nothing written. Re-run with --apply.`,
);
host.close();
