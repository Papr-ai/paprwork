#!/usr/bin/env node
/**
 * Count listeners attached to `document`, twice, to see whether any are accumulating.
 *
 * An effect that re-runs on a loop leaks any listener its cleanup forgets. The
 * count alone is ambiguous — a large app legitimately has many — so this samples
 * twice and reports the growth, which is the part that cannot be explained away.
 *
 *   node scripts/count-document-listeners.mjs [--port 9333] [--seconds 6]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const seconds = Number(flag("seconds", 6));

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(
  (t) => t.type === "page" && (t.url.includes("localhost:5173") || t.url.startsWith("file://")),
);
if (!target) {
  console.error("no chat UI target");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));

let id = 0;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    const onMessage = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id !== myId) return;
      ws.off("message", onMessage);
      if (m.error) return reject(new Error(m.error.message));
      resolve(m.result);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

async function snapshot() {
  const { result } = await call("Runtime.evaluate", { expression: "document" });
  const { listeners } = await call("DOMDebugger.getEventListeners", {
    objectId: result.objectId,
    depth: 0,
  });
  const byType = new Map();
  for (const l of listeners) byType.set(l.type, (byType.get(l.type) || 0) + 1);
  await call("Runtime.releaseObject", { objectId: result.objectId });
  return { total: listeners.length, byType };
}

const before = await snapshot();
console.log(`waiting ${seconds}s — leave the app idle\n`);
await new Promise((r) => setTimeout(r, seconds * 1000));
const after = await snapshot();
ws.close();

console.log(`document listeners: ${before.total} -> ${after.total}  (+${after.total - before.total} in ${seconds}s)\n`);
const types = new Set([...before.byType.keys(), ...after.byType.keys()]);
const rows = [...types]
  .map((t) => [t, before.byType.get(t) || 0, after.byType.get(t) || 0])
  .sort((a, b) => b[2] - b[1] - (a[2] - a[1]));
for (const [type, b, a] of rows) {
  const delta = a - b;
  console.log(`  ${type.padEnd(22)} ${String(b).padStart(5)} -> ${String(a).padStart(5)}  ${delta > 0 ? `+${delta}  <-- GROWING` : ""}`);
}
