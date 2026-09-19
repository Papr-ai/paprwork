#!/usr/bin/env node
/**
 * Audit which mini-apps use browser storage, which keys they use, and which
 * apps collide on the same key.
 *
 * Why this exists: after per-app process isolation (Enhancement 115) each app
 * gets its own origin, so each gets its own `localStorage`. Apps that kept
 * state there start empty unless their keys are migrated. This script answers
 * the two questions the migration needs:
 *
 *   1. Which apps have anything to migrate at all?
 *   2. Which keys are claimed by more than one app?
 *
 * The second question is the interesting one. A key claimed by two apps is
 * already corrupting today on the shared origin — last writer wins and the
 * other app silently reads someone else's value. Isolation *fixes* that; the
 * migration just decides what each side starts from.
 *
 * Attribution is static: a key is attributed to an app if the app's source
 * mentions it. Over-attribution is cheap (a key copied into the app's own
 * origin, which that app could already read on the shared origin) while
 * under-attribution loses data, so the matching is deliberately generous —
 * `dist/` is scanned as well as source, and template-literal and concatenated
 * keys contribute a *prefix* rather than being skipped.
 *
 *   node scripts/audit-app-browser-storage.mjs
 *   node scripts/audit-app-browser-storage.mjs --root ~/clones --json manifest.json
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

/**
 * Keys owned by the Paprwork shell itself, not by any app.
 *
 * These live on the shared origin because in a packaged build the renderer is
 * served from the gateway, so the shell and every same-origin app iframe wrote
 * into one storage area. They must never be copied into an app origin: the
 * cloud-sync snapshot alone is ~2.5MB of the user's workspace state, and an app
 * that could read it would be reading far more than its own data.
 *
 * This list wins over source attribution, because a bundled chunk that happens
 * to mention one of these names is not a claim of ownership.
 */
const PLATFORM_KEY_PREFIXES = [
  "paprwork.",
  "paprwork_",
  "paprwork-",
  "papr-onboarding",
  "papr-activation",
  "papr-profile-sidebar-cache",
];

export function isPlatformKey(key) {
  return PLATFORM_KEY_PREFIXES.some((p) => key.startsWith(p));
}

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html", ".svelte", ".vue"]);
const SKIP_DIR = new Set(["node_modules", ".git", ".versions", "venv", "__pycache__", ".next", "coverage"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".well-known") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(full, out);
    } else if (SOURCE_EXT.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Pull the key expression out of every storage call, then reduce it to either
 * an exact key or a prefix.
 *
 * A template literal or a concatenation cannot yield an exact key — the app
 * writes `vc-photo-${slug}` and the stored key is `vc-photo-konstantin-…`. The
 * literal head is the only stable part, so it becomes a prefix. Dropping these
 * would lose the largest values in the store (base64 photos), which is the
 * opposite of the failure we can afford.
 */
const CALL = /\b(localStorage|sessionStorage)\s*(?:\.\s*(?:get|set|remove)Item\s*\(|\[)\s*([^\n]{0,200})/g;
const QUOTED_HEAD = /^(['"])((?:\\.|(?!\1)[^\\])*)\1/;
const TEMPLATE_HEAD = /^`([^`$]*)\$\{/;
const TEMPLATE_WHOLE = /^`([^`$]*)`/;
// `` `${PREFIX}-${id}` `` — an interpolated constant, then the literal tail
// before the next hole.
const TEMPLATE_INTERP_HEAD = /^`\$\{\s*([A-Za-z_$][\w$]*)\s*\}([^`$]*)/;
// A bare identifier as the key. The follow character decides whether it is the
// whole key or only its head; `.` is deliberately absent from that set, so
// `KEYS.theme` is skipped rather than attributed to whatever `KEYS` resolves to.
const IDENT_HEAD = /^([A-Za-z_$][\w$]*)\s*([)\],+])/;

const CONST_DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g;

/**
 * Collect `const NAME = 'literal'` bindings so a call site naming the constant
 * resolves instead of contributing nothing.
 *
 * This is the pattern that actually matters in practice. Leadership Sync
 * declares `const SCHEMA_KEY = 'ds-schema-v4'` and then calls
 * `getItem(SCHEMA_KEY)`, so a call-site-only reader attributes nothing and the
 * stored key looks orphaned — which is exactly how it presented.
 *
 * Built across the whole app rather than per file, because the declaration is
 * routinely in a module the call site imports (`utils/avatarCache.ts` here).
 * Two files declaring the same name with different values will collide, and the
 * last one wins; that is over-attribution at worst, which this file already
 * argues is the affordable direction.
 */
export function collectStringConstants(sources) {
  const map = new Map();
  for (const source of sources) {
    for (const m of source.matchAll(CONST_DECL)) {
      if (m[3].length > 0) map.set(m[1], m[3]);
    }
  }
  return map;
}

export function extractKeys(source, constants = new Map()) {
  const exact = new Set();
  const prefixes = new Set();
  for (const m of source.matchAll(CALL)) {
    const expr = m[2].trimStart();
    const quoted = QUOTED_HEAD.exec(expr);
    if (quoted) {
      const literal = quoted[2];
      const rest = expr.slice(quoted[0].length).trimStart();
      // `"launchpad:" + name` — the literal is a prefix, not the whole key.
      if (rest.startsWith("+")) prefixes.add(literal);
      else if (literal.length > 0) exact.add(literal);
      continue;
    }
    const tmplWhole = TEMPLATE_WHOLE.exec(expr);
    if (tmplWhole) {
      if (tmplWhole[1].length > 0) exact.add(tmplWhole[1]);
      continue;
    }
    const tmplInterp = TEMPLATE_INTERP_HEAD.exec(expr);
    if (tmplInterp) {
      const head = constants.get(tmplInterp[1]);
      if (head) prefixes.add(head + tmplInterp[2]);
      continue;
    }
    const tmpl = TEMPLATE_HEAD.exec(expr);
    // A bare `${…}` head gives us nothing to match on; recording "" would
    // claim every key in the store, so an unreadable key is skipped instead.
    if (tmpl && tmpl[1].length > 0) {
      prefixes.add(tmpl[1]);
      continue;
    }
    const ident = IDENT_HEAD.exec(expr);
    if (ident) {
      const resolved = constants.get(ident[1]);
      if (resolved) (ident[2] === "+" ? prefixes : exact).add(resolved);
    }
  }
  return { exact, prefixes };
}

export function usesIndexedDb(source) {
  return /\bindexedDB\s*\.\s*open\s*\(/.test(source);
}

function readTitle(appDir) {
  for (const name of ["metadata.json", "app.json", "package.json"]) {
    const p = path.join(appDir, name);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      const t = j.title || j.name || j.displayName;
      if (t) return String(t);
    } catch {
      /* A malformed metadata file is not a reason to skip the app. */
    }
  }
  return path.basename(appDir);
}

export function auditApp(appDir) {
  const exact = new Set();
  const prefixes = new Set();
  let idb = false;
  let files = 0;

  // Read once, keep the text: a constant is regularly declared in a module the
  // call site imports, so the bindings have to be known before any file is
  // scanned. Storage-using apps are small enough for this to cost nothing.
  const sources = [];
  for (const file of walk(appDir)) {
    try {
      sources.push(readFileSync(file, "utf8"));
    } catch {
      /* Unreadable file — nothing to attribute from it. */
    }
  }
  const constants = collectStringConstants(sources);

  for (const src of sources) {
    if (!/localStorage|sessionStorage|indexedDB/.test(src)) continue;
    files += 1;
    const k = extractKeys(src, constants);
    for (const e of k.exact) if (!isPlatformKey(e)) exact.add(e);
    for (const p of k.prefixes) if (!isPlatformKey(p)) prefixes.add(p);
    if (usesIndexedDb(src)) idb = true;
  }
  return {
    id: path.basename(appDir),
    title: readTitle(appDir),
    filesTouchingStorage: files,
    exactKeys: [...exact].sort(),
    keyPrefixes: [...prefixes].sort(),
    usesIndexedDb: idb,
  };
}

function defaultRoot() {
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

// The migration imports auditApp/isPlatformKey from here, so the CLI body must
// not run on import — otherwise every app is scanned twice and the migration
// prints an audit report nobody asked for.
//
// Compared by URL rather than `import.meta.main`: that landed in Node 24.2 and
// these scripts get run under whatever node is on PATH, where it is silently
// `undefined` and the CLI would print nothing at all.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runCli();

function runCli() {
const root = path.resolve((flag("root") || defaultRoot()).replace(/^~/, homedir()));
if (!existsSync(root)) {
  console.error(`no app root at ${root}`);
  process.exit(1);
}

const appDirs = readdirSync(root)
  .map((n) => path.join(root, n))
  .filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

const audited = appDirs.map(auditApp);
const withStorage = audited.filter(
  (a) => a.exactKeys.length || a.keyPrefixes.length || a.usesIndexedDb,
);

// A claim is a key or prefix; two apps claiming the same one collide today.
const claims = new Map();
for (const app of withStorage) {
  for (const k of [...app.exactKeys, ...app.keyPrefixes]) {
    if (!claims.has(k)) claims.set(k, []);
    claims.get(k).push(app);
  }
}
const collisions = [...claims.entries()]
  .filter(([, apps]) => apps.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

const collidingApps = new Set(collisions.flatMap(([, apps]) => apps.map((a) => a.id)));

if (has("json")) {
  const out = flag("json");
  writeFileSync(
    out,
    JSON.stringify(
      {
        root,
        generatedAt: new Date().toISOString(),
        apps: withStorage,
        collisions: collisions.map(([key, apps]) => ({
          key,
          apps: apps.map((a) => ({ id: a.id, title: a.title })),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`manifest written to ${out}`);
}

console.log(`root: ${root}`);
console.log(`apps scanned: ${audited.length}   using browser storage: ${withStorage.length}`);
console.log(`apps in a collision group: ${collidingApps.size}\n`);

if (collisions.length) {
  console.log("COLLIDING KEYS — these apps overwrite each other on the shared origin today:");
  for (const [key, apps] of collisions) {
    console.log(`  ${key}`);
    for (const a of apps) console.log(`      ${a.title}  (${a.id})`);
  }
  console.log();
}

console.log("PER-APP CLAIMS:");
for (const a of withStorage.sort((x, y) => x.title.localeCompare(y.title))) {
  const marks = [
    a.usesIndexedDb ? "idb" : null,
    collidingApps.has(a.id) ? "COLLIDES" : null,
  ].filter(Boolean);
  console.log(`  ${a.title}  (${a.id})${marks.length ? `  [${marks.join(", ")}]` : ""}`);
  for (const k of a.exactKeys) console.log(`      = ${k}`);
  for (const p of a.keyPrefixes) console.log(`      ~ ${p}*`);
}
}
