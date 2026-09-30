#!/usr/bin/env node
/**
 * Report where a renderer's main thread time actually goes, split into script,
 * style, layout and paint — plus whether anything is animating.
 *
 * The V8 sampler buckets everything that is not JavaScript as `(program)`, so a
 * trace showing 100% `(program)` says only "not script". These counters say
 * which of the non-script phases it is, which is the difference between a CSS
 * animation and a layout thrash.
 *
 *   node scripts/renderer-native-work.mjs [--port 9333] [--seconds 6]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const seconds = Number(flag("seconds", 6));

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

const metrics = async () => {
  const { metrics } = await send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
};

await send("Performance.enable");
const before = await metrics();
const t0 = Date.now();
await new Promise((r) => setTimeout(r, seconds * 1000));
const after = await metrics();
const wallMs = Date.now() - t0;

const delta = (k) => (after[k] ?? 0) - (before[k] ?? 0);
const pct = (secondsValue) => `${((secondsValue * 1000 / wallMs) * 100).toFixed(1)}%`;

console.log(`over ${(wallMs / 1000).toFixed(1)}s of wall time:\n`);
console.log(`  script     ${pct(delta("ScriptDuration")).padStart(7)}   (${delta("ScriptDuration").toFixed(2)}s)`);
console.log(`  style      ${pct(delta("RecalcStyleDuration")).padStart(7)}   (${delta("RecalcStyleDuration").toFixed(2)}s, ${delta("RecalcStyleCount")} recalcs)`);
console.log(`  layout     ${pct(delta("LayoutDuration")).padStart(7)}   (${delta("LayoutDuration").toFixed(2)}s, ${delta("LayoutCount")} layouts)`);
console.log(`  task total ${pct(delta("TaskDuration")).padStart(7)}   (${delta("TaskDuration").toFixed(2)}s)`);
console.log(`\n  DOM nodes ${after.Nodes}   listeners ${after.JSEventListeners}   JS heap ${(after.JSHeapUsedSize / 1e6).toFixed(0)}MB / ${(after.JSHeapTotalSize / 1e6).toFixed(0)}MB`);
console.log(`  frames ${delta("Frames")} over ${(wallMs / 1000).toFixed(1)}s = ${(delta("Frames") / (wallMs / 1000)).toFixed(0)} fps`);

// Anything animating keeps the compositor and the main thread busy regardless
// of whether script is running, so ask the page directly.
const { result } = await send("Runtime.evaluate", {
  returnByValue: true,
  expression: `(() => {
    const anims = document.getAnimations().map((a) => ({
      state: a.playState,
      name: a.animationName || (a.effect && a.effect.getTiming && a.effect.getTiming().duration) || "?",
      target: a.effect && a.effect.target
        ? a.effect.target.className || a.effect.target.tagName
        : "?",
    }));
    const running = anims.filter((a) => a.state === "running");
    const byTarget = {};
    for (const a of running) {
      const k = String(a.target).slice(0, 60);
      byTarget[k] = (byTarget[k] || 0) + 1;
    }
    return {
      totalAnimations: anims.length,
      running: running.length,
      runningByTarget: byTarget,
      // Is a turn in flight? A streaming turn legitimately paints continuously.
      stopButtons: document.querySelectorAll('[aria-label*="Stop"],[title*="Stop"]').length,
      spinners: document.querySelectorAll('[class*="spinner"],[class*="loading"],[class*="pulse"]').length,
      visibility: document.visibilityState,
    };
  })()`,
});
console.log(`\nanimations: ${JSON.stringify(result.value, null, 2)}`);

ws.close();
