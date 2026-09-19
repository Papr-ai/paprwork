#!/usr/bin/env node
/**
 * Name the code doing localStorage reads and writes, with stack traces.
 *
 * A rate alone does not say who. Both halves of the chat UI's idle loop touch
 * localStorage on their way round — the profile store persists a snapshot on
 * every write, and the cloud-sync cache is read on every render — so capturing
 * the caller at the storage boundary identifies both.
 *
 *   node scripts/trace-storage-callers.mjs [--port 9333] [--seconds 5]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const seconds = Number(flag("seconds", 5));

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
const evaluate = (expression) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    const onMessage = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id !== myId) return;
      ws.off("message", onMessage);
      if (m.error) return reject(new Error(m.error.message));
      if (m.result?.exceptionDetails) return reject(new Error(m.result.exceptionDetails.text));
      resolve(m.result?.result?.value);
    };
    ws.on("message", onMessage);
    ws.send(
      JSON.stringify({
        id: myId,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });

await evaluate(`
  (() => {
    if (window.__paprStorageTrace) { window.__paprStorageTrace.restore(); }

    const proto = Object.getPrototypeOf(localStorage);
    const realGet = proto.getItem;
    const realSet = proto.setItem;
    const tally = new Map();   // "op key <- frames" -> count

    // Our own frames only. Framework frames are the same for every caller and
    // would collapse distinct callers onto one bucket.
    const ourFrames = (stack) =>
      (stack || "")
        .split("\\n")
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => !l.includes("/chunk-") && !l.includes("node_modules") && l.includes("localhost:5173"))
        .map((l) => {
          const m = l.match(/at\\s+(?:([\\w$.<>]+)\\s+\\()?.*\\/([^\\/?)]+)(?:\\?[^:)]*)?:(\\d+):\\d+/);
          return m ? \`\${m[1] || "?"}@\${m[2]}:\${m[3]}\` : null;
        })
        .filter(Boolean)
        .slice(0, 4);

    const record = (op, key) => {
      const frames = ourFrames(new Error().stack).join(" <- ") || "(framework only)";
      const k = \`\${op} \${key}\\n      \${frames}\`;
      tally.set(k, (tally.get(k) || 0) + 1);
    };

    proto.getItem = function (key) { record("get", key); return realGet.call(this, key); };
    proto.setItem = function (key, v) { record("set", key); return realSet.call(this, key, v); };

    window.__paprStorageTrace = {
      startedAt: performance.now(),
      restore() { proto.getItem = realGet; proto.setItem = realSet; },
      report() {
        const secs = (performance.now() - this.startedAt) / 1000;
        return { secs: +secs.toFixed(1),
                 rows: [...tally].sort((a,b) => b[1]-a[1]).slice(0, 14)
                         .map(([k, v]) => [k, +(v/secs).toFixed(1)]) };
      },
    };
    return "installed";
  })()
`);

console.log(`tracing for ${seconds}s — leave the app idle\n`);
await new Promise((r) => setTimeout(r, seconds * 1000));
const report = JSON.parse(await evaluate(`JSON.stringify(window.__paprStorageTrace.report())`));
await evaluate(`window.__paprStorageTrace.restore()`);
ws.close();

console.log(`per second, over ${report.secs}s\n`);
for (const [what, rate] of report.rows) {
  console.log(`  ${String(rate).padStart(6)}/s  ${what}\n`);
}
