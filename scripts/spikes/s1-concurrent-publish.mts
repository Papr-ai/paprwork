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
const probes: Record<string, { t: number; ms: number; ok: boolean }[]> = { status: [], dbq: [], items: [] };
const PROBE_APP = process.env.PROBE_APP ?? appIds[0];
async function probe(name: string, url: string, init?: RequestInit) {
  while (!stop) {
    const s = performance.now();
    let ok = false;
    try { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }); ok = r.ok; await r.text(); } catch {}
    probes[name].push({ t: Date.now() - t0, ms: performance.now() - s, ok });
    await new Promise((r) => setTimeout(r, 500));
  }
}
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

const CURSORS = path.join(NS, "data/app-repo-commit-cursors.json");
const readCursor = (id: string) => { try { const c = JSON.parse(fs.readFileSync(CURSORS, "utf8")); return (c.cursors ?? c)[id]?.lastCommitSha ?? null; } catch { return null; } };
const startCursor = Object.fromEntries(appIds.map((id) => [id, readCursor(id)]));
const committedAt: Record<string, number> = {};
async function poller() {
  await new Promise((r) => setTimeout(r, 3000));
  while (!stop && Date.now() - t0 < MAX_MS) {
    try {
      const j: any = await (await fetch(`${GW}/api/sync/status`)).json();
      const busy: string[] = j.cloudPublishingAppIds ?? [];
      const active = busy.join(",") || undefined;
      const queued: string[] = j.queueRemaining ? [`remaining:${j.queueRemaining}`] : [];
      statusLog.push({ t: Date.now() - t0, active, queued });
      for (const id of appIds) if (!committedAt[id] && readCursor(id) && readCursor(id) !== startCursor[id]) committedAt[id] = Date.now() - t0;
      if (Object.keys(committedAt).length === appIds.length) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop = true;
}

const samp = sampler();
const probeRuns = [
  probe("status", `${GW}/api/sync/status`),
  probe("items", `${GW}/api/sync/items?appId=${PROBE_APP}`),
  probe("dbq", `${GW}/api/db/query`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: PROBE_APP, sourceId: "lab", sql: "SELECT COUNT(*) n FROM events" }) }),
];
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
await Promise.all(probeRuns);
const pstat = (a: { ms: number; ok: boolean }[]) => { const m = a.map((x) => x.ms).sort((x, y) => x - y);
  return { n: m.length, p50: Math.round(m[Math.floor(m.length / 2)] ?? 0), p99: Math.round(m[Math.floor(m.length * 0.99)] ?? 0),
    max: Math.round(m[m.length - 1] ?? 0), fails: a.filter((x) => !x.ok).length }; };

const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
const freezes = samples.filter((s) => s.ms > 100);
const out = {
  label, appIds, durationMs: Date.now() - t0, n: ms.length,
  p50: q(0.5), p99: q(0.99), max: ms[ms.length - 1],
  over100: freezes.length, freezes: freezes.map((f) => ({ t: f.t, ms: Math.round(f.ms) })),
  probes: Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, pstat(v)])),
  committedAt, notCommitted: appIds.filter((id) => !committedAt[id]),
  publishedSeen: [...new Set(statusLog.flatMap((x) => (x.active ?? "").split(",").filter(Boolean)))],
  statusLog,
};
fs.writeFileSync(`/tmp/s1-concurrent-${label}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, statusLog: statusLog.length }, null, 2));
