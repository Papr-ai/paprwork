#!/usr/bin/env node
/**
 * Sample a running renderer's JavaScript and report self time by function.
 *
 * Needs PAPR_PLATFORM_EMBEDDED_CDP=1 and a PAPR_PLATFORM_CDP_PORT that real
 * Chrome is not already holding — Chromium does not fail loudly when the
 * debugging port is taken, it simply never listens, so a collision looks
 * exactly like the feature being off.
 *
 *   node scripts/profile-renderer.mjs [--port 9333] [--seconds 10] [--target chat|app|list]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const port = Number(flag("port", process.env.PAPR_PLATFORM_CDP_PORT || 9333));
const seconds = Number(flag("seconds", 10));
const want = flag("target", "chat");

/** The chat UI is served by Vite in dev and from a file:// bundle in packaged builds. */
const isChatUi = (url) =>
  url.includes("localhost:5173") || url.startsWith("file://");
const isMiniApp = (url) => /\/\/app-[0-9a-f-]+\.localhost/.test(url);

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: ${res.status}`);
  return (await res.json()).filter((t) => t.type === "page" || t.type === "iframe");
}

function send(ws, id, method, params) {
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

/**
 * A sample names the leaf frame only, so self time is the sum of the deltas
 * that land on each node. Aggregating by callFrame rather than by node id
 * merges the same function reached from different call paths.
 */
function selfTimeByFunction(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const totals = new Map();
  const { samples = [], timeDeltas = [] } = profile;

  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    if (!node) continue;
    const f = node.callFrame;
    const where = f.url ? `${f.url.split("/").pop()}:${f.lineNumber + 1}` : "(native)";
    const key = `${f.functionName || "(anonymous)"}  ${where}`;
    totals.set(key, (totals.get(key) || 0) + (timeDeltas[i] || 0) / 1000);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

const targets = await listTargets();
if (want === "list" || targets.length === 0) {
  console.log(`targets on 127.0.0.1:${port}:`);
  for (const t of targets) console.log(`  ${t.type.padEnd(7)} ${t.url}`);
  if (targets.length === 0) console.log("  (none — is the app running with CDP enabled?)");
  process.exit(0);
}

const match = want === "app" ? isMiniApp : isChatUi;
const target = targets.find((t) => match(t.url)) || targets[0];
console.log(`profiling ${target.url}\nsampling for ${seconds}s — leave the app idle\n`);

const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));

await send(ws, 1, "Profiler.enable");
await send(ws, 2, "Profiler.setSamplingInterval", { interval: 100 });
await send(ws, 3, "Profiler.start");
await new Promise((r) => setTimeout(r, seconds * 1000));
const { profile } = await send(ws, 4, "Profiler.stop");
ws.close();

const rows = selfTimeByFunction(profile);
const wall = seconds * 1000;
const busy = rows.reduce((a, [, ms]) => a + ms, 0);
const idleMs = rows.find(([k]) => k.startsWith("(idle)"))?.[1] ?? 0;

console.log(`main thread: ${(((busy - idleMs) / wall) * 100).toFixed(0)}% busy over ${seconds}s\n`);
console.log("self time  share  function");
for (const [key, ms] of rows.slice(0, 20)) {
  console.log(`${(ms / 1000).toFixed(2)}s`.padStart(8), `${((ms / wall) * 100).toFixed(1)}%`.padStart(6), ` ${key}`);
}
