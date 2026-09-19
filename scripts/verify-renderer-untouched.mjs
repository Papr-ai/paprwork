#!/usr/bin/env node
/**
 * Confirm the diagnostics left nothing behind in the live renderer.
 *
 * trace-forced-layout.mjs replaces geometry getters and bisect-animation-layout.mjs
 * appends a probe element. Both restore on exit, but "it should have" is not a
 * reading — and a still-patched `getBoundingClientRect` would be a real behaviour
 * change we caused, so it has to be checked rather than assumed.
 *
 *   node scripts/verify-renderer-untouched.mjs [--port 9333]
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

const { result } = await send("Runtime.evaluate", {
  returnByValue: true,
  expression: `(() => {
    // A native getter stringifies as "[native code]"; a patched one shows its body.
    const native = (fn) => typeof fn === "function" && /\\[native code\\]/.test(Function.prototype.toString.call(fn));
    const getterOf = (ctor, prop) => {
      const d = Object.getOwnPropertyDescriptor(window[ctor].prototype, prop);
      return d && d.get;
    };
    return {
      traceHookPresent: Boolean(window.__paprLayoutTrace),
      probeElementPresent: Boolean(document.getElementById("__papr_anim_probe")),
      geometryNative: {
        offsetHeight: native(getterOf("HTMLElement", "offsetHeight")),
        scrollHeight: native(getterOf("Element", "scrollHeight")),
        scrollTop: native(getterOf("Element", "scrollTop")),
        clientHeight: native(getterOf("Element", "clientHeight")),
        getBoundingClientRect: native(Element.prototype.getBoundingClientRect),
        getClientRects: native(Element.prototype.getClientRects),
      },
      // Whatever the app itself is doing, for context.
      chatPanes: document.querySelectorAll('[class*="chat-container"]').length,
      messages: document.querySelectorAll('[class*="message-item"]').length,
      visibility: document.visibilityState,
    };
  })()`,
});

const v = result.value;
const patched = Object.entries(v.geometryNative).filter(([, isNative]) => !isNative);

console.log(`trace hook present:    ${v.traceHookPresent ? "YES (leftover!)" : "no"}`);
console.log(`probe element present: ${v.probeElementPresent ? "YES (leftover!)" : "no"}`);
console.log(
  `geometry getters:      ${patched.length === 0 ? "all native (clean)" : `PATCHED: ${patched.map(([k]) => k).join(", ")}`}`,
);
console.log(`\nchat panes mounted: ${v.chatPanes}   message nodes: ${v.messages}   visibility: ${v.visibility}`);

ws.close();
