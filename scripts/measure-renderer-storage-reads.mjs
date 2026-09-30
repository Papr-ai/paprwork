#!/usr/bin/env node
/**
 * Count synchronous localStorage reads per key in a running renderer.
 *
 * A read is main-thread blocking I/O plus a JSON.parse at the call site, so the
 * rate is the quantity that matters — a large payload read once is fine, a small
 * one read on every render is not.
 *
 *   node scripts/measure-renderer-storage-reads.mjs [--port 9333] [--seconds 3]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const seconds = Number(flag("seconds", 3));

const res = await fetch(`http://127.0.0.1:${port}/json/list`);
const targets = await res.json();
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
function evaluate(expression, awaitPromise = false) {
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
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise },
      }),
    );
  });
}

/**
 * Patch the prototype rather than the instance: the call sites reach getItem
 * through `localStorage`, which resolves the prototype method each time.
 */
await evaluate(`
  (() => {
    if (window.__paprStorageProbe) return "already";
    const counts = new Map();
    const bytes = new Map();
    const native = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      counts.set(key, (counts.get(key) || 0) + 1);
      const out = native.call(this, key);
      if (typeof out === "string") {
        bytes.set(key, out.length);
      }
      return out;
    };
    window.__paprStorageProbe = { counts, bytes, native, startedAt: performance.now() };
    return "installed";
  })()
`);

await new Promise((r) => setTimeout(r, seconds * 1000));

const report = await evaluate(`
  (() => {
    const p = window.__paprStorageProbe;
    const elapsedMs = performance.now() - p.startedAt;
    Storage.prototype.getItem = p.native;
    delete window.__paprStorageProbe;
    return {
      elapsedMs,
      rows: [...p.counts.entries()]
        .map(([key, count]) => ({ key, count, bytes: p.bytes.get(key) || 0 }))
        .sort((a, b) => b.count - a.count),
    };
  })()
`);
ws.close();

const secs = report.elapsedMs / 1000;
console.log(`localStorage.getItem calls over ${secs.toFixed(1)}s (app idle)\n`);
console.log("  calls    per sec   payload  key");
for (const { key, count, bytes } of report.rows.slice(0, 12)) {
  const kb = bytes >= 1024 ? `${(bytes / 1024).toFixed(0)}KB` : `${bytes}B`;
  console.log(
    `  ${String(count).padStart(7)}  ${(count / secs).toFixed(0).padStart(8)}  ${kb.padStart(8)}  ${key}`,
  );
}
const total = report.rows.reduce((a, r) => a + r.count, 0);
const parsed = report.rows.reduce((a, r) => a + r.count * r.bytes, 0);
console.log(
  `\n  ${total} reads (${(total / secs).toFixed(0)}/s), ${(parsed / secs / 1024 / 1024).toFixed(1)}MB/s read and parsed`,
);
