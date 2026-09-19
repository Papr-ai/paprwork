#!/usr/bin/env node
/**
 * Print the heaviest call path in a renderer, root-first.
 *
 * Self time names the function burning CPU; it does not name what is calling it
 * on a loop. This walks the sampling profile's tree and follows the heaviest
 * child at each step, which is what identifies the driver.
 *
 *   node scripts/profile-renderer-tree.mjs [--port 9333] [--seconds 10]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const seconds = Number(flag("seconds", 10));

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
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    const onMessage = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id !== myId) return;
      ws.off("message", onMessage);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 100 });
await send("Profiler.start");
console.log(`profiling ${target.url} for ${seconds}s — leave the app idle\n`);
await new Promise((r) => setTimeout(r, seconds * 1000));
const { profile } = await send("Profiler.stop");
ws.close();

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const { samples = [], timeDeltas = [] } = profile;
for (let i = 0; i < samples.length; i++) {
  self.set(samples[i], (self.get(samples[i]) || 0) + (timeDeltas[i] || 0) / 1000);
}

/** Total = own samples plus every descendant's. Memoized; the tree is a DAG-free tree. */
const totalCache = new Map();
function total(nodeId) {
  if (totalCache.has(nodeId)) return totalCache.get(nodeId);
  const node = byId.get(nodeId);
  let sum = self.get(nodeId) || 0;
  for (const child of node?.children || []) sum += total(child);
  totalCache.set(nodeId, sum);
  return sum;
}

const label = (node) => {
  const f = node.callFrame;
  const where = f.url ? `${f.url.split("/").pop().split("?")[0]}:${f.lineNumber + 1}` : "native";
  return `${f.functionName || "(anonymous)"} — ${where}`;
};

const root = profile.nodes[0];
const wall = seconds * 1000;
console.log(`heaviest path (total time, root first)\n`);

let cursor = root;
const seen = new Set();
for (let depth = 0; depth < 40; depth++) {
  if (seen.has(cursor.id)) break;
  seen.add(cursor.id);
  const t = total(cursor.id);
  const name = label(cursor);
  if (!name.startsWith("(root)") && !name.startsWith("(idle)")) {
    console.log(
      `${"  ".repeat(Math.min(depth, 20))}${((t / wall) * 100).toFixed(1).padStart(5)}%  ${name}`,
    );
  }
  const children = (cursor.children || [])
    .map((c) => byId.get(c))
    .filter(Boolean)
    .filter((c) => !label(c).startsWith("(idle)"))
    .sort((a, b) => total(b.id) - total(a.id));
  if (children.length === 0) break;
  cursor = children[0];
}

// Roots of work: direct children of (root) and of (program), which is where a
// timer, a microtask drain, or an event handler enters.
console.log(`\nentry points (direct children of root)\n`);
const entries = (root.children || [])
  .map((c) => byId.get(c))
  .filter(Boolean)
  .map((c) => ({ node: c, t: total(c.id) }))
  .sort((a, b) => b.t - a.t)
  .slice(0, 8);
for (const { node, t } of entries) {
  console.log(`${((t / wall) * 100).toFixed(1).padStart(6)}%  ${label(node)}`);
  for (const gc of (node.children || [])
    .map((c) => byId.get(c))
    .filter(Boolean)
    .map((c) => ({ node: c, t: total(c.id) }))
    .sort((a, b) => b.t - a.t)
    .slice(0, 5)) {
    console.log(`        ${((gc.t / wall) * 100).toFixed(1).padStart(5)}%    ${label(gc.node)}`);
  }
}
