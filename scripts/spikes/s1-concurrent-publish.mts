/**
 * S1 concurrency spike: publish N apps at once, sample gateway /health every 100 ms.
 * Usage: node --import tsx scripts/spikes/s1-concurrent-publish.mts <label> <appId...>
 * Writes /tmp/s1-concurrent-<label>.json
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GW = "http://localhost:18789";
const [label, ...appIds] = process.argv.slice(2);
const NS = path.join(os.homedir(), "Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V");
const MAX_MS = 8 * 60_000;

for (const id of appIds) {
  const f = path.join(NS, "apps", id, "index.html");
  fs.appendFileSync(f, `\n<!-- s1 ${label} ${Date.now()} -->\n`);
}

const samples: { t: number; ms: number; ok: boolean }[] = [];
const statusLog: { t: number; active?: string; queued: string[] }[] = [];
const t0 = Date.now();
let stop = false;

async function sampler() {
  while (!stop) {
    const s = performance.now();
    let ok = false;
    try {
      const r = await fetch(`${GW}/health`, { signal: AbortSignal.timeout(15_000) });
      ok = r.ok;
    } catch {}
    samples.push({ t: Date.now() - t0, ms: performance.now() - s, ok });
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function poller() {
  await new Promise((r) => setTimeout(r, 3000));
  while (!stop && Date.now() - t0 < MAX_MS) {
    try {
      const j: any = await (await fetch(`${GW}/api/sync/status`)).json();
      const busy: string[] = j.cloudPublishingAppIds ?? [];
      const active = busy.join(",") || undefined;
      const queued: string[] = j.queueRemaining ? [`remaining:${j.queueRemaining}`] : [];
      statusLog.push({ t: Date.now() - t0, active, queued });
      if (!active && queued.length === 0 && Date.now() - t0 > 15_000) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop = true;
}

const samp = sampler();
await new Promise((r) => setTimeout(r, 1500));
await Promise.all(
  appIds.map((appId) =>
    fetch(`${GW}/api/sync/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId }),
    }).then((r) => r.status),
  ),
);
await poller();
await samp;

const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
const freezes = samples.filter((s) => s.ms > 100);
const out = {
  label, appIds, durationMs: Date.now() - t0, n: ms.length,
  p50: q(0.5), p99: q(0.99), max: ms[ms.length - 1],
  over100: freezes.length, freezes: freezes.map((f) => ({ t: f.t, ms: Math.round(f.ms) })),
  statusLog,
};
fs.writeFileSync(`/tmp/s1-concurrent-${label}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, statusLog: statusLog.length }, null, 2));
