#!/usr/bin/env node
/**
 * Name the component that is scheduling the renders.
 *
 * Self time names what is expensive; it does not name what is calling it on a
 * loop. React's dev build records the fibers that scheduled each commit in
 * `root.memoizedUpdaters` for DevTools, which answers exactly that.
 *
 *   node scripts/find-render-loop.mjs [--port 9333] [--seconds 6]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const seconds = Number(flag("seconds", 6));

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

const install = await evaluate(`
  (() => {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return "no-hook";
    if (window.__paprLoopProbe) { window.__paprLoopProbe.reset(); return "reset"; }

    const commits = { n: 0 };
    const updaters = new Map();
    const rendered = new Map();

    const nameOf = (fiber) => {
      const t = fiber?.type;
      if (!t) return fiber?.tag === 3 ? "(HostRoot)" : "(unknown)";
      if (typeof t === "string") return t;
      return t.displayName || t.name || t.render?.name || t.type?.name || "(anonymous)";
    };

    const prev = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = function (rendererId, root, ...rest) {
      try {
        commits.n++;
        // Fibers that scheduled this update. Dev-only, kept for DevTools.
        for (const fiber of root.memoizedUpdaters || []) {
          const k = nameOf(fiber);
          updaters.set(k, (updaters.get(k) || 0) + 1);
        }
        // Function components that actually re-rendered in this commit.
        const seen = new Set();
        const walk = (fiber, depth) => {
          while (fiber && depth < 400) {
            if ((fiber.tag === 0 || fiber.tag === 14 || fiber.tag === 15) && fiber.alternate) {
              const k = nameOf(fiber);
              if (!seen.has(k)) { seen.add(k); rendered.set(k, (rendered.get(k) || 0) + 1); }
            }
            if (fiber.child) walk(fiber.child, depth + 1);
            fiber = fiber.sibling;
          }
        };
        if (root.current) walk(root.current, 0);
      } catch {}
      return prev ? prev.call(this, rendererId, root, ...rest) : undefined;
    };

    window.__paprLoopProbe = {
      commits, updaters, rendered, startedAt: performance.now(),
      reset() { commits.n = 0; updaters.clear(); rendered.clear(); this.startedAt = performance.now(); },
      report() {
        const secs = (performance.now() - this.startedAt) / 1000;
        const top = (m) => [...m].sort((a,b) => b[1]-a[1]).slice(0, 12).map(([k,v]) => [k, +(v/secs).toFixed(1)]);
        return { secs: +secs.toFixed(1), commitsPerSec: +(commits.n/secs).toFixed(1),
                 updaters: top(updaters), rendered: top(rendered) };
      },
    };
    return "installed";
  })()
`);

if (install === "no-hook") {
  console.error("React DevTools hook not present — is this a dev build?");
  ws.close();
  process.exit(1);
}

console.log(`probe ${install}; sampling ${seconds}s — leave the app idle\n`);
await new Promise((r) => setTimeout(r, seconds * 1000));
const report = await evaluate(`JSON.stringify(window.__paprLoopProbe.report())`);
ws.close();

const r = JSON.parse(report);
console.log(`${r.commitsPerSec} commits/sec over ${r.secs}s\n`);
console.log("who SCHEDULED the updates (per sec)");
if (r.updaters.length === 0) console.log("  (none recorded — updater tracking may be off)");
for (const [name, n] of r.updaters) console.log(`  ${String(n).padStart(6)}  ${name}`);
console.log("\nwho RE-RENDERED (per sec)");
for (const [name, n] of r.rendered) console.log(`  ${String(n).padStart(6)}  ${name}`);
