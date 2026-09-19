#!/usr/bin/env node
/**
 * Report the size and composition of the cloud-sync localStorage snapshot.
 *
 * The key is read synchronously and JSON.parsed at every call site, so its size
 * is a main-thread cost multiplied by the read rate — measure both together.
 *
 *   node scripts/measure-cloud-sync-snapshot.mjs [--port 9333]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));

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

const value = await new Promise((resolve, reject) => {
  const onMessage = (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id !== 1) return;
    ws.off("message", onMessage);
    if (msg.error) return reject(new Error(msg.error.message));
    resolve(msg.result?.result?.value);
  };
  ws.on("message", onMessage);
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        returnByValue: true,
        expression: `
          (() => {
            const rows = [];
            let total = 0;
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              const len = (localStorage.getItem(key) || "").length;
              total += len;
              rows.push({ key, len });
            }
            rows.sort((a, b) => b.len - a.len);

            const raw = localStorage.getItem("paprwork.cloudSyncSnapshot.v2");
            let apps = [];
            let topLevel = [];
            if (raw) {
              const snap = JSON.parse(raw);
              topLevel = Object.entries(snap).map(([k, v]) => ({
                k,
                len: JSON.stringify(v ?? null).length,
              })).sort((a, b) => b.len - a.len);
              apps = Object.entries(snap.syncItemsByAppId || {}).map(([id, v]) => ({
                id,
                len: JSON.stringify(v).length,
              })).sort((a, b) => b.len - a.len);
            }
            return { rows: rows.slice(0, 8), total, apps, topLevel };
          })()
        `,
      },
    }),
  );
});
ws.close();

const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(0)}KB` : `${n}B`);

console.log(`localStorage total: ${kb(value.total)} across ${value.rows.length}+ keys\n`);
console.log("  size      key");
for (const r of value.rows) console.log(`  ${kb(r.len).padStart(8)}  ${r.key}`);

console.log(`\ncloudSyncSnapshot.v2 composition:\n`);
console.log("  size      field");
for (const t of value.topLevel) console.log(`  ${kb(t.len).padStart(8)}  ${t.k}`);

console.log(`\n  syncItemsByAppId holds ${value.apps.length} apps:\n`);
console.log("  size      appId");
for (const a of value.apps) console.log(`  ${kb(a.len).padStart(8)}  ${a.id}`);
