#!/usr/bin/env node
/**
 * Diff one component's hook state across commits, to name the hook that changes.
 *
 * `find-render-loop.mjs` says which component schedules; it does not say which
 * of that component's hooks is reporting a new value. React keeps the hooks as a
 * linked list on the fiber, so comparing them commit to commit answers it.
 *
 *   node scripts/diff-component-hooks.mjs --component MessageItemInner [--seconds 5]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const seconds = Number(flag("seconds", 5));
const component = flag("component", "MessageItemInner");

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

const status = await evaluate(`
  (() => {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return "no-hook";
    const WANT = ${JSON.stringify(component)};

    const nameOf = (f) => {
      const t = f?.type;
      if (!t) return null;
      if (typeof t === "string") return null;
      return t.displayName || t.name || null;
    };

    // Shallow, bounded description — enough to tell "same" from "different"
    // without serializing a whole message object.
    const describe = (v, depth) => {
      if (v === null) return "null";
      if (v === undefined) return "undefined";
      const t = typeof v;
      if (t === "function") return "fn:" + (v.name || "anon");
      if (t !== "object") return t + ":" + String(v).slice(0, 40);
      if (Array.isArray(v)) return "[" + v.length + "]";
      if (v instanceof Map) return "Map(" + v.size + ")";
      if (v instanceof Set) return "Set(" + v.size + ")";
      if (depth <= 0) return "{" + Object.keys(v).slice(0, 6).join(",") + "}";
      const keys = Object.keys(v).slice(0, 8);
      return "{" + keys.map((k) => k + ":" + describe(v[k], depth - 1)).join(",") + "}";
    };

    const changes = new Map();   // "hookIndex" -> count of commits where identity changed
    const samples = new Map();   // "hookIndex" -> last [before, after] pair
    const commits = { n: 0 };

    // Hook identity is what React compares, so record the reference AND a
    // description: a changed reference with an identical description is the
    // signature of a selector building a fresh value from unchanged data.
    let lastRefs = null;
    let lastDescs = null;

    const prev = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = function (rendererId, root, ...rest) {
      try {
        commits.n++;
        let fiber = null;
        const walk = (f, d) => {
          while (f && d < 400 && !fiber) {
            if (nameOf(f) === WANT) { fiber = f; return; }
            if (f.child) walk(f.child, d + 1);
            f = f.sibling;
          }
        };
        if (root.current) walk(root.current, 0);

        if (fiber) {
          const refs = [];
          const descs = [];
          let h = fiber.memoizedState;
          let i = 0;
          while (h && i < 40) {
            refs.push(h.memoizedState);
            descs.push(describe(h.memoizedState, 2));
            h = h.next;
            i++;
          }
          if (lastRefs) {
            for (let k = 0; k < Math.max(refs.length, lastRefs.length); k++) {
              if (refs[k] !== lastRefs[k]) {
                const key = String(k);
                changes.set(key, (changes.get(key) || 0) + 1);
                samples.set(key, [lastDescs?.[k] ?? "-", descs[k] ?? "-"]);
              }
            }
          }
          lastRefs = refs;
          lastDescs = descs;
        }
      } catch {}
      return prev ? prev.call(this, rendererId, root, ...rest) : undefined;
    };

    window.__paprHookProbe = {
      startedAt: performance.now(),
      report() {
        const secs = (performance.now() - this.startedAt) / 1000;
        return {
          secs: +secs.toFixed(1),
          commits: commits.n,
          hooks: [...changes].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({
            index: +k, changesPerSec: +(v / secs).toFixed(1),
            before: samples.get(k)?.[0], after: samples.get(k)?.[1],
          })),
        };
      },
    };
    return "installed";
  })()
`);

if (status === "no-hook") {
  console.error("React DevTools hook not present");
  ws.close();
  process.exit(1);
}

console.log(`watching ${component} for ${seconds}s — leave the app idle\n`);
await new Promise((r) => setTimeout(r, seconds * 1000));
const report = JSON.parse(await evaluate(`JSON.stringify(window.__paprHookProbe.report())`));
ws.close();

console.log(`${report.commits} commits in ${report.secs}s\n`);
if (report.hooks.length === 0) {
  console.log("no hook identity changed — the re-render is coming from props or context.");
} else {
  console.log("hooks whose value identity changed (per sec)\n");
  for (const h of report.hooks) {
    const same = h.before === h.after ? "  <-- SAME VALUE, new reference" : "";
    console.log(`  hook[${h.index}]  ${String(h.changesPerSec).padStart(6)}/s${same}`);
    console.log(`      before: ${String(h.before).slice(0, 160)}`);
    console.log(`      after:  ${String(h.after).slice(0, 160)}\n`);
  }
}
