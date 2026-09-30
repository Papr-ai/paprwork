#!/usr/bin/env node
/**
 * Prune the cloud-sync localStorage snapshot in a running renderer.
 *
 * `syncItemsByAppId` accumulates a full SyncItemsResponse per app and is never
 * pruned, while `readCloudSyncTabSnapshot` reads and JSON.parses the whole key
 * synchronously on every call. Size times read rate is main-thread time.
 *
 * Everything dropped here is a cache the publish bar refetches from
 * /api/sync/items, and every read path already has a null branch — so this
 * costs one refetch per app, not data. It is relief, not a fix: the write path
 * refills it as apps are opened.
 *
 *   node scripts/prune-cloud-sync-snapshot.mjs            # dry run
 *   node scripts/prune-cloud-sync-snapshot.mjs --apply
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const apply = args.includes("--apply");

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(
  (t) => t.type === "page" && (t.url.includes("localhost:5173") || t.url.startsWith("file://")),
);
if (!target) {
  console.error("no chat UI target — is the app running with CDP enabled?");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));

let nextId = 1;
function evaluate(expression) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== id) return;
      ws.off("message", onMessage);
      if (msg.error) return reject(new Error(msg.error.message));
      if (msg.result?.exceptionDetails) {
        return reject(new Error(msg.result.exceptionDetails.text));
      }
      resolve(msg.result?.result?.value);
    };
    ws.on("message", onMessage);
    ws.send(
      JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }),
    );
  });
}

const SYNC_KEY = "paprwork.cloudSyncSnapshot.v2";
const PUBLISH_KEY = "paprwork.cloudPublishSnapshot.v1";

const plan = await evaluate(`
  (() => {
    const raw = localStorage.getItem(${JSON.stringify(SYNC_KEY)});
    if (!raw) return { missing: true };
    const snap = JSON.parse(raw);

    // Keep the small fields the status derivation reads directly; drop the two
    // per-app caches, which are the entire size and are refetchable.
    const kept = {
      gitStatus: snap.gitStatus ?? null,
      vaultStatus: snap.vaultStatus ?? null,
      syncItems: null,
      savedAt: snap.savedAt ?? Date.now(),
    };

    return {
      before: raw.length,
      after: JSON.stringify(kept).length,
      appCount: Object.keys(snap.syncItemsByAppId || {}).length,
      publishBefore: (localStorage.getItem(${JSON.stringify(PUBLISH_KEY)}) || "").length,
      kept: JSON.stringify(kept),
    };
  })()
`);

if (plan.missing) {
  console.log(`${SYNC_KEY} is not present — nothing to prune.`);
  ws.close();
  process.exit(0);
}

const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(0)}KB` : `${n}B`);
const reads = 54; // measured; see scripts/measure-renderer-storage-reads.mjs

console.log(`${SYNC_KEY}`);
console.log(`  now:    ${kb(plan.before)}  (${plan.appCount} apps cached in syncItemsByAppId)`);
console.log(`  after:  ${kb(plan.after)}`);
console.log(
  `\n  at the measured ${reads} reads/sec that is ` +
    `${((plan.before * reads) / 1024 / 1024).toFixed(0)}MB/s -> ` +
    `${((plan.after * reads) / 1024).toFixed(0)}KB/s parsed on the main thread`,
);
console.log(`\n${PUBLISH_KEY}\n  now:    ${kb(plan.publishBefore)}\n  after:  0B (removed)`);

if (!apply) {
  console.log("\ndry run — re-run with --apply to write");
  ws.close();
  process.exit(0);
}

const result = await evaluate(`
  (() => {
    localStorage.setItem(${JSON.stringify(SYNC_KEY)}, ${JSON.stringify(plan.kept)});
    localStorage.removeItem(${JSON.stringify(PUBLISH_KEY)});
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      total += (localStorage.getItem(localStorage.key(i)) || "").length;
    }
    return { syncNow: (localStorage.getItem(${JSON.stringify(SYNC_KEY)}) || "").length, total };
  })()
`);
ws.close();

console.log(`\napplied. ${SYNC_KEY} is now ${kb(result.syncNow)}; localStorage total ${kb(result.total)}.`);
console.log("The publish bar will refetch per app on next view.");
