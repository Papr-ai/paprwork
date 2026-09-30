#!/usr/bin/env node
/**
 * Attribute layout churn to a specific animation, by running one at a time
 * against an otherwise idle page.
 *
 * Reading the keyframes is not enough: whether a property forces layout depends
 * on how the element is composited, so `transform` on one element is free and on
 * another is not. Measuring `LayoutCount` with exactly one animation running is
 * the only reading that settles it.
 *
 * Requires an idle renderer — check with watch-renderer-phases.mjs first, since a
 * baseline above zero makes every row unattributable.
 *
 *   node scripts/bisect-animation-layout.mjs [--port 9333]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));

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

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
};

await send("Performance.enable");
const metrics = async () => {
  const { metrics } = await send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
};

/** Class names carrying the animations seen running during a streamed turn. */
const CANDIDATES = [
  "working-label-shimmer",
  "working-secondary-shimmer",
  "thinking-cursor",
  "exploring-tool-dot",
  "ctx-ring__label",
];

async function measure(label, setup, teardown) {
  await evaluate(setup);
  // Let the first frame settle so the measurement covers steady state.
  await new Promise((r) => setTimeout(r, 400));
  const before = await metrics();
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 2500));
  const after = await metrics();
  const wall = Date.now() - t0;
  await evaluate(teardown);

  const d = (k) => (after[k] ?? 0) - (before[k] ?? 0);
  const perSec = (n) => (n / (wall / 1000)).toFixed(0);
  console.log(
    [
      label.padEnd(28),
      `${perSec(d("LayoutCount"))} layouts/s`.padStart(16),
      `${perSec(d("RecalcStyleCount"))} styles/s`.padStart(15),
      `layout ${((d("LayoutDuration") * 1000 / wall) * 100).toFixed(1)}%`.padStart(14),
      `task ${((d("TaskDuration") * 1000 / wall) * 100).toFixed(1)}%`.padStart(12),
    ].join("  "),
  );
}

console.log("one animation at a time, against the live stylesheet:\n");

await measure("(baseline: nothing added)", "1", "1");

for (const className of CANDIDATES) {
  await measure(
    className,
    `(() => {
      const el = document.createElement("div");
      el.id = "__papr_anim_probe";
      el.className = ${JSON.stringify(className)};
      el.textContent = "Working on it";
      el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:999999;pointer-events:none";
      document.body.appendChild(el);
      return el.className;
    })()`,
    `(() => { const el = document.getElementById("__papr_anim_probe"); if (el) el.remove(); return 1; })()`,
  );
}

// Whatever the page itself was doing, listed with the properties each animates —
// the class probes above only cover names we guessed from the CSS.
const live = await evaluate(`(() => {
  return document.getAnimations().map((a) => {
    const target = a.effect && a.effect.target;
    let props = [];
    try {
      props = [...new Set(a.effect.getKeyframes().flatMap((k) =>
        Object.keys(k).filter((p) => !["offset", "computedOffset", "easing", "composite"].includes(p))))];
    } catch {}
    return {
      state: a.playState,
      name: a.animationName || "(web animation)",
      props,
      target: target ? (target.className || target.tagName) : "?",
    };
  });
})()`);
console.log(`\nlive animations on the page right now: ${JSON.stringify(live, null, 2)}`);

ws.close();
