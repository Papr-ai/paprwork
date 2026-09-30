#!/usr/bin/env node
/**
 * Name the code forcing synchronous layout in a running renderer.
 *
 * Reading a geometry property after a DOM write makes the browser lay out
 * immediately rather than at the next frame. Done in a loop it burns a core and
 * paints nothing, which is exactly what the Performance counters show when
 * LayoutCount climbs while Frames stays at zero — so the counters prove it is
 * happening and this says who is doing it.
 *
 * Patches the geometry getters to record a stack, samples for a few seconds,
 * then restores them.
 *
 *   node scripts/trace-forced-layout.mjs [--port 9333] [--seconds 6]
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

const install = `(() => {
  if (window.__paprLayoutTrace) return "already installed";
  const counts = new Map();
  const restore = [];

  // Only the properties that force layout when read. Deliberately narrow: each
  // patch costs a stack capture, so tracing something harmless would add noise
  // and slow the very path being measured.
  const props = {
    HTMLElement: ["offsetHeight", "offsetWidth", "offsetTop", "offsetLeft"],
    Element: ["scrollHeight", "scrollWidth", "scrollTop", "scrollLeft", "clientHeight", "clientWidth"],
  };

  for (const [ctorName, names] of Object.entries(props)) {
    const proto = window[ctorName].prototype;
    for (const name of names) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || !desc.get) continue;
      restore.push([proto, name, desc]);
      Object.defineProperty(proto, name, {
        ...desc,
        get() {
          // Frame 0 is this getter, frame 1 is Error, so start at the caller.
          const stack = (new Error().stack || "").split("\\n").slice(2, 7).join("\\n");
          const key = name + "\\n" + stack;
          counts.set(key, (counts.get(key) || 0) + 1);
          return desc.get.call(this);
        },
      });
    }
  }

  // Also record methods that force layout.
  for (const [ctorName, method] of [["Element", "getBoundingClientRect"], ["Element", "getClientRects"]]) {
    const proto = window[ctorName].prototype;
    const original = proto[method];
    restore.push([proto, method, { value: original, writable: true, configurable: true }]);
    proto[method] = function (...a) {
      const stack = (new Error().stack || "").split("\\n").slice(2, 7).join("\\n");
      counts.set(method + "\\n" + stack, (counts.get(method + "\\n" + stack) || 0) + 1);
      return original.apply(this, a);
    };
  }

  window.__paprLayoutTrace = {
    counts,
    stop() {
      for (const [proto, name, desc] of restore) Object.defineProperty(proto, name, desc);
      delete window.__paprLayoutTrace;
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    },
  };
  return "installed";
})()`;

const { result: installed } = await send("Runtime.evaluate", {
  expression: install,
  returnByValue: true,
});
console.log(`geometry trace: ${installed.value}`);
console.log(`sampling for ${seconds}s...\n`);

await new Promise((r) => setTimeout(r, seconds * 1000));

const { result } = await send("Runtime.evaluate", {
  expression: `JSON.stringify(window.__paprLayoutTrace.stop())`,
  returnByValue: true,
});

const rows = JSON.parse(result.value);
if (rows.length === 0) {
  console.log("no geometry reads recorded — the layout is not being forced from script");
} else {
  for (const [key, count] of rows) {
    const [prop, ...stack] = key.split("\n");
    console.log(`${String(count).padStart(6)}x  ${prop}`);
    for (const frame of stack) console.log(`          ${frame.trim()}`);
    console.log();
  }
}

ws.close();
