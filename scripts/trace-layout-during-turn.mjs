#!/usr/bin/env node
/**
 * Capture Chromium's own timeline trace while a turn is streaming, and report
 * what is driving layout.
 *
 * Patching geometry getters only catches the APIs you thought to patch — it
 * missed `getComputedStyle`, `scrollTo` and the observers, and accounted for 40
 * of ~680 layouts. The renderer records the triggering stack itself, so ask it
 * rather than guessing which API to instrument.
 *
 * Waits for a turn to start, traces for a few seconds, then summarises.
 *
 *   node scripts/trace-layout-during-turn.mjs [--port 9333] [--seconds 6] [--wait 180]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const seconds = Number(flag("seconds", 6));
const waitSeconds = Number(flag("wait", 180));

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
const traceEvents = [];
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.method === "Tracing.dataCollected") traceEvents.push(...msg.params.value);
});

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
  const { result } = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  return result.value;
};

await send("Performance.enable");
const layoutCount = async () => {
  const { metrics } = await send("Performance.getMetrics");
  return metrics.find((m) => m.name === "LayoutCount")?.value ?? 0;
};

// Busy-ness is the trigger, not the presence of a stop button: the button's
// markup varies and the churn is what we are here to explain.
console.log(`waiting up to ${waitSeconds}s for layout churn to start...`);
const deadline = Date.now() + waitSeconds * 1000;
let busy = false;
while (Date.now() < deadline) {
  const before = await layoutCount();
  await new Promise((r) => setTimeout(r, 1500));
  const rate = (await layoutCount() - before) / 1.5;
  if (rate > 20) {
    console.log(`churn detected (${rate.toFixed(0)} layouts/s) — tracing ${seconds}s\n`);
    busy = true;
    break;
  }
}
if (!busy) {
  console.log("renderer stayed quiet — send a message and run this again");
  ws.close();
  process.exit(0);
}

await send("Tracing.start", {
  transferMode: "ReportEvents",
  traceConfig: {
    includedCategories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.stack",
      "blink.user_timing",
    ],
  },
});
await new Promise((r) => setTimeout(r, seconds * 1000));
await send("Tracing.end");
await new Promise((resolve) => {
  const onMessage = (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === "Tracing.tracingComplete") {
      ws.off("message", onMessage);
      resolve();
    }
  };
  ws.on("message", onMessage);
});

// --- summarise -------------------------------------------------------------

const byName = new Map();
for (const e of traceEvents) {
  if (e.ph !== "X" && e.ph !== "B") continue;
  const entry = byName.get(e.name) ?? { count: 0, dur: 0 };
  entry.count += 1;
  entry.dur += e.dur ?? 0;
  byName.set(e.name, entry);
}

console.log("top timeline events:\n");
const top = [...byName.entries()]
  .sort((a, b) => b[1].dur - a[1].dur)
  .slice(0, 14);
for (const [name, { count, dur }] of top) {
  console.log(
    `${String(count).padStart(6)}x  ${(dur / 1000).toFixed(0).padStart(6)}ms  ${name}`,
  );
}

// Chromium tags a layout forced from script, and records the stack that did it.
const forced = traceEvents.filter(
  (e) =>
    (e.name === "Layout" || e.name === "UpdateLayoutTree") &&
    e.args?.beginData?.stackTrace?.length,
);
const stacks = new Map();
for (const e of forced) {
  const frames = e.args.beginData.stackTrace
    .slice(0, 5)
    .map((f) => `${f.functionName || "(anon)"} @ ${String(f.url).split("/").pop()}:${f.lineNumber}`)
    .join("\n          ");
  const entry = stacks.get(frames) ?? { count: 0, dur: 0 };
  entry.count += 1;
  entry.dur += e.dur ?? 0;
  stacks.set(frames, entry);
}

console.log(`\nlayouts with a recorded JS stack: ${forced.length}\n`);
for (const [frames, { count, dur }] of [...stacks.entries()]
  .sort((a, b) => b[1].dur - a[1].dur)
  .slice(0, 8)) {
  console.log(`${String(count).padStart(6)}x  ${(dur / 1000).toFixed(0)}ms`);
  console.log(`          ${frames}\n`);
}

// Where no stack is recorded, the trigger is the renderer's own lifecycle —
// which of those is running tells us which invalidation to chase.
const lifecycle = ["Layout", "UpdateLayoutTree", "Paint", "PrePaint", "Commit",
  "RunTask", "FunctionCall", "TimerFire", "FireAnimationFrame", "HitTest",
  "ScheduleStyleRecalculation", "InvalidateLayout", "ResizeObserver"];
console.log("lifecycle counts:");
for (const name of lifecycle) {
  const e = byName.get(name);
  if (e) console.log(`  ${name.padEnd(28)} ${String(e.count).padStart(6)}x  ${(e.dur / 1000).toFixed(0)}ms`);
}

ws.close();
