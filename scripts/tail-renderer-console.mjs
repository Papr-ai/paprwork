#!/usr/bin/env node
/**
 * Tail a renderer's console over CDP, de-duplicated with counts.
 *
 * The Electron log pipeline forwards renderer warnings and errors only, and
 * only when DevTools is attached — so absence there proves nothing. This reads
 * the console directly.
 *
 *   node scripts/tail-renderer-console.mjs [--port 9333] [--seconds 8]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const seconds = Number(flag("seconds", 8));

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
const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params }));

const seen = new Map();
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.method !== "Runtime.consoleAPICalled" && msg.method !== "Log.entryAdded") return;

  const level =
    msg.method === "Log.entryAdded" ? msg.params.entry.level : msg.params.type;
  const text =
    msg.method === "Log.entryAdded"
      ? msg.params.entry.text
      : (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? a.unserializableValue ?? `<${a.type}>`)
          .join(" ");

  if (level !== "warning" && level !== "error" && level !== "assert") return;

  // First stack frame, when React gives one — it names the component.
  const frame = msg.params.stackTrace?.callFrames?.find((f) => f.url && !f.url.includes("chunk-"));
  const where = frame ? ` @ ${frame.url.split("/").pop().split("?")[0]}:${frame.lineNumber + 1}` : "";
  const key = `${level}: ${text.slice(0, 200)}${where}`;
  seen.set(key, (seen.get(key) || 0) + 1);
});

send("Runtime.enable");
send("Log.enable");
console.log(`listening for ${seconds}s — leave the app idle\n`);
await new Promise((r) => setTimeout(r, seconds * 1000));
ws.close();

if (seen.size === 0) {
  console.log("no warnings or errors.");
} else {
  for (const [text, count] of [...seen].sort((a, b) => b[1] - a[1])) {
    console.log(`x${String(count).padStart(5)}  ${text}\n`);
  }
}
