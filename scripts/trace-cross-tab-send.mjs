#!/usr/bin/env node
/**
 * Time a send from the click to the paint, so a missing message bubble can be
 * attributed rather than guessed at.
 *
 * Three different faults produce the same complaint ("I sent it and nothing
 * appeared"), and they need opposite fixes:
 *
 *   1. the send path stalled before the store write   — `chat:create`, a send
 *      lock, or an interrupt awaited ahead of `addMessage`
 *   2. the store was written and React never painted  — main thread saturated,
 *      which is what 85 layouts/s with 0 frames looks like
 *   3. the store write landed on the wrong chat       — or was wiped by a
 *      history load racing the send
 *
 * `useAgent.sendMessage` already logs each stage, so the gaps between those
 * lines separate (1) from (2), and the frame counter says whether anything
 * reached the screen. Also samples the rendered message count, which is the
 * only direct evidence for (3).
 *
 *   node scripts/trace-cross-tab-send.mjs [--port 9333] [--minutes 10]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const minutes = Number(flag("minutes", 10));

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
const pending = new Map();
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled") onConsole(msg.params);
});
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Stages `sendMessage` logs, in the order it reaches them. */
const STAGES = [
  ["START", /\[useAgent\.sendMessage\] ========== START/],
  ["chatId", /\[useAgent\.sendMessage\] ChatId:/],
  ["interrupting", /\[useAgent\] Interrupting active stream/],
  ["creating chat", /\[useAgent\] First message - creating permanent chat/],
  ["chat created", /\[useAgent\] Created permanent chat/],
  ["USER MSG IN STORE", /\[useAgent\] User message added to store/],
  ["calling stream", /\[useAgent\] State reset, about to call gateway\.stream/],
  ["first chunk", /\[useAgent\] (Received first chunk|chunk #1\b)/],
  ["history skipped", /\[useChat\] Skipping loadMessages/],
  ["history loaded", /Loaded \d+ messages/],
];

let turnStartedAt = null;
let lastAt = null;

function onConsole(params) {
  const text = (params.args || [])
    .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
    .join(" ");
  const stage = STAGES.find(([, re]) => re.test(text));
  if (!stage) return;

  const now = Date.now();
  if (stage[0] === "START") {
    turnStartedAt = now;
    lastAt = now;
    console.log(`\n${new Date().toTimeString().slice(0, 8)}  ---- send started ----`);
  }
  const sinceStart = turnStartedAt ? now - turnStartedAt : 0;
  const sinceLast = lastAt ? now - lastAt : 0;
  lastAt = now;

  // A gap before the store write is fault (1); a gap after it is fault (2).
  const flagSlow = sinceLast > 300 ? "  <-- SLOW" : "";
  console.log(
    `   +${String(sinceStart).padStart(6)}ms  (+${String(sinceLast).padStart(5)}ms)  ${stage[0].padEnd(18)} ${text.slice(0, 90)}${flagSlow}`,
  );
}

await send("Runtime.enable");
await send("Performance.enable");

const metrics = async () => {
  const { metrics } = await send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
};

const pageState = async () => {
  const { result } = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      messages: document.querySelectorAll('[class*="message-item"]').length,
      panes: document.querySelectorAll('[class*="chat-container"]').length,
      streaming: document.querySelectorAll('[aria-label*="Stop"],[title*="Stop"]').length > 0,
    }))()`,
  });
  return result.value;
};

console.log(
  `watching for ${minutes} min on port ${port}.\n` +
    `send a message in a second chat tab while the first is streaming.\n`,
);
console.log("time      state      msgs  panes  layouts/s  fps  script  task");

let prev = await metrics();
let prevAt = Date.now();
const until = Date.now() + minutes * 60_000;

while (Date.now() < until) {
  await new Promise((r) => setTimeout(r, 4000));
  const now = await metrics();
  const state = await pageState();
  const wall = Date.now() - prevAt;
  const d = (k) => (now[k] ?? 0) - (prev[k] ?? 0);
  const pct = (s) => `${((s * 1000) / wall * 100).toFixed(1)}%`.padStart(6);

  console.log(
    [
      new Date().toTimeString().slice(0, 8),
      (state.streaming ? "STREAMING" : "idle     ").padEnd(10),
      String(state.messages).padStart(4),
      String(state.panes).padStart(6),
      String(Math.round(d("LayoutCount") / (wall / 1000))).padStart(10),
      // Zero frames while the main thread is busy is paint starvation: React
      // may have committed and the user still sees nothing.
      String(Math.round(d("Frames") / (wall / 1000))).padStart(4),
      pct(d("ScriptDuration")),
      pct(d("TaskDuration")),
    ].join("  "),
  );

  prev = now;
  prevAt = Date.now();
}

ws.close();
