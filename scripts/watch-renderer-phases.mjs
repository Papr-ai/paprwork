#!/usr/bin/env node
/**
 * Watch a renderer's main-thread phases alongside whether a turn is streaming.
 *
 * The question a single sample cannot answer is whether busy-ness is the cost of
 * work in progress or a loop running regardless. Streaming legitimately paints
 * continuously; an idle renderer should not. So report both together and let the
 * idle rows be the verdict.
 *
 *   node scripts/watch-renderer-phases.mjs [--port 9333] [--minutes 5]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const minutes = Number(flag("minutes", 5));
const everyMs = 6000;

const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
  .filter((t) => t.type === "page");
const target = targets.find(
  (t) => t.url.includes("localhost:5173") || t.url.startsWith("file://"),
);
if (!target) {
  console.log("no chat page target found");
  process.exit(0);
}

const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== id) return;
      ws.off("message", onMessage);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Performance.enable");
const metrics = async () => {
  const { metrics } = await send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
};

const pageState = async () => {
  const { result } = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      streaming: document.querySelectorAll('[aria-label*="Stop"],[title*="Stop"]').length > 0,
      running: document.getAnimations().filter((a) => a.playState === "running").length,
    }))()`,
  });
  return result.value;
};

console.log(
  "time      state      script  style   layout  layouts/s  task    heapMB  nodes  listeners",
);

let prev = await metrics();
let prevAt = Date.now();
const until = Date.now() + minutes * 60_000;

while (Date.now() < until) {
  await new Promise((r) => setTimeout(r, everyMs));
  const now = await metrics();
  const state = await pageState();
  const wall = Date.now() - prevAt;
  const d = (k) => (now[k] ?? 0) - (prev[k] ?? 0);
  const pct = (s) => `${((s * 1000 / wall) * 100).toFixed(1)}%`.padStart(6);

  console.log(
    [
      new Date().toTimeString().slice(0, 8),
      (state.streaming ? "STREAMING" : "idle     ").padEnd(10),
      pct(d("ScriptDuration")),
      pct(d("RecalcStyleDuration")),
      pct(d("LayoutDuration")),
      String(Math.round(d("LayoutCount") / (wall / 1000))).padStart(9),
      pct(d("TaskDuration")),
      String(Math.round(now.JSHeapUsedSize / 1e6)).padStart(7),
      String(now.Nodes).padStart(6),
      String(now.JSEventListeners).padStart(10),
    ].join("  "),
  );

  prev = now;
  prevAt = Date.now();
}

ws.close();
