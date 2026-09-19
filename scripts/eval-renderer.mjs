#!/usr/bin/env node
/**
 * Evaluate an expression in the live chat renderer and print the result.
 *
 * Exists so a reading can be checked rather than assumed — a DOM selector that
 * matches nothing reports "0", which is indistinguishable from the thing being
 * absent, and that conflation is worth exactly one script to avoid.
 *
 *   node scripts/eval-renderer.mjs '(() => document.title)()'
 *   node scripts/eval-renderer.mjs --file probe.js [--port 9333]
 */
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const file = flag("file", null);
const expression = file
  ? readFileSync(file, "utf8")
  : args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--port");

if (!expression) {
  console.error("usage: node scripts/eval-renderer.mjs '<expression>' | --file <path>");
  process.exit(1);
}

const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
  .filter((t) => t.type === "page");
const target = targets.find(
  (t) => t.url.includes("localhost:5173") || t.url.startsWith("file://"),
);
if (!target) {
  console.error("no chat page target found");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));

const id = 1;
const result = await new Promise((resolve, reject) => {
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id !== id) return;
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  });
  ws.send(
    JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }),
  );
});

if (result.exceptionDetails) {
  console.error(result.exceptionDetails.text);
  console.error(result.exceptionDetails.exception?.description ?? "");
  process.exit(1);
}
console.log(JSON.stringify(result.result.value, null, 2));
ws.close();
