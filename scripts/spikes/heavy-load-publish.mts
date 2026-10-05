/**
 * Heavy-load publish test: N apps publish at once while the machine is busy.
 *
 * Load: CPU hogs on (cores - 1) child processes + the publishes themselves.
 * Probes (every 100-500 ms): /health, /api/sync/status, /api/db/query.
 * Gates (exit 1 on fail): /health p99 < 250 ms, max < 1000 ms, 0 failures;
 * db/query p99 < 500 ms; every app commits within MAX_MS.
 *
 * Usage: node --import tsx scripts/spikes/heavy-load-publish.mts <label> <appId...>
 *   HOGS=0 disables CPU load. PROBE_APP/PROBE_SOURCE/PROBE_SQL pick the db probe.
 * Writes /tmp/heavy-load-<label>.json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const GW = "http://localhost:18789";
const [label, ...appIds] = process.argv.slice(2);
if (!label || appIds.length === 0) {
  console.error("usage: heavy-load-publish.mts <label> <appId...>");
  process.exit(2);
}
const NS = path.join(os.homedir(), "Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V");
const MAX_MS = Number(process.env.MAX_MS ?? 6 * 60_000);
const HOGS = Number(process.env.HOGS ?? Math.max(1, os.cpus().length - 1));

// ── Refuse to run until cloud sync is up (it starts 30s-2.5min after launch) ──
{
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const st: any = await fetch(`${GW}/api/sync/status`).then((r) => r.json(), () => ({}));
    if (st.enabled) break;
    if (Date.now() > deadline) {
      console.error("cloud sync never initialized:", st.reason);
      process.exit(3);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Worker restarts before this run (e.g. a deliberate respawn) don't count against it.
const restartsBefore: number = await fetch(`${GW}/api/debug/gateway-performance`)
  .then((r) => r.json())
  .then((d: any) => d.publishWorker?.restarts ?? 0, () => 0);

// ── CPU hogs (separate processes so they compete with the gateway for cores) ──
const hogs = Array.from({ length: HOGS }, () =>
  spawn(process.execPath, ["-e", "for(;;){Math.sqrt(Math.random())}"], { stdio: "ignore" }),
);
const killHogs = () => hogs.forEach((h) => h.kill("SIGKILL"));
process.on("exit", killHogs);
process.on("SIGINT", () => process.exit(130));

// ── Dirty every app so each publish has real work ──
for (const id of appIds) {
  fs.appendFileSync(path.join(NS, "apps", id, "index.html"), `\n<!-- load ${label} ${Date.now()} -->\n`);
}

type Sample = { t: number; ms: number; ok: boolean };
const t0 = Date.now();
let stop = false;
const series: Record<string, Sample[]> = { health: [], status: [], dbq: [] };

async function loop(name: string, url: string, everyMs: number, init?: RequestInit) {
  while (!stop) {
    const s = performance.now();
    let ok = false;
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      ok = r.ok;
      await r.text();
    } catch {}
    series[name].push({ t: Date.now() - t0, ms: performance.now() - s, ok });
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const PROBE_APP = process.env.PROBE_APP ?? appIds[0];
const probes = [
  loop("health", `${GW}/health`, 100),
  loop("status", `${GW}/api/sync/status`, 500),
  loop("dbq", `${GW}/api/db/query`, 500, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appId: PROBE_APP,
      sourceId: process.env.PROBE_SOURCE ?? "lab",
      sql: process.env.PROBE_SQL ?? "SELECT 1 AS n",
    }),
  }),
];

const CURSORS = path.join(NS, "data/app-repo-commit-cursors.json");
const readCursor = (id: string): string | null => {
  try {
    const c = JSON.parse(fs.readFileSync(CURSORS, "utf8"));
    return (c.cursors ?? c)[id]?.lastCommitSha ?? null;
  } catch {
    return null;
  }
};
const startCursor = Object.fromEntries(appIds.map((id) => [id, readCursor(id)]));
const committedAt: Record<string, number> = {};
let maxParallel = 0;

await new Promise((r) => setTimeout(r, 2000)); // baseline under CPU load
const pushStatus = await Promise.all(
  appIds.map((appId) =>
    fetch(`${GW}/api/sync/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId }),
    }).then((r) => r.status, () => 0),
  ),
);
if (pushStatus.some((s) => s < 200 || s >= 300)) {
  console.error("push rejected:", pushStatus);
  stop = true;
  killHogs();
  process.exit(4);
}

while (Date.now() - t0 < MAX_MS) {
  for (const id of appIds) {
    const cur = readCursor(id);
    if (!committedAt[id] && cur && cur !== startCursor[id]) committedAt[id] = Date.now() - t0;
  }
  try {
    const st: any = await (await fetch(`${GW}/api/sync/status`)).json();
    maxParallel = Math.max(maxParallel, (st.cloudPublishingAppIds ?? []).length);
  } catch {}
  if (Object.keys(committedAt).length === appIds.length) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const committedMs = Date.now() - t0;

// A commit lands mid-publish; keep measuring until every publish has finished.
while (Date.now() - t0 < MAX_MS) {
  const perf: any = await fetch(`${GW}/api/debug/gateway-performance`).then((r) => r.json(), () => ({}));
  const done = new Set(
    (perf.recentFlushes ?? [])
      .filter((f: any) => Date.parse(f.finishedAt ?? 0) >= t0)
      .map((f: any) => f.appId),
  );
  if (appIds.every((id) => done.has(id))) break;
  await new Promise((r) => setTimeout(r, 2000));
}
stop = true;
await Promise.all(probes);
killHogs();

let flushes: any[] = [];
let worker: any = null;
try {
  const perf = (await (await fetch(`${GW}/api/debug/gateway-performance`)).json()) as any;
  flushes = (perf.recentFlushes ?? []).filter((f: any) => Date.parse(f.finishedAt ?? 0) >= t0);
  worker = perf.publishWorker ?? null;
} catch {}
const okFlushApps = new Set(flushes.filter((f) => f.outcome === "ok").map((f) => f.appId));
const workerApps = new Set(
  (worker?.recent ?? [])
    .filter((r: any) => r.ok && Date.parse(r.finishedAt) >= t0)
    .map((r: any) => r.appId),
);

const stat = (a: Sample[]) => {
  const m = a.map((x) => x.ms).sort((x, y) => x - y);
  const q = (p: number) => Math.round(m[Math.min(m.length - 1, Math.floor(p * m.length))] ?? 0);
  return { n: m.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(m.at(-1) ?? 0),
    fails: a.filter((x) => !x.ok).length, over250: a.filter((x) => x.ms > 250).length };
};
const result = {
  maxParallel,
  label, appIds, hogs: HOGS, pushStatus, committedMs, durationMs: Date.now() - t0,
  probes: Object.fromEntries(Object.entries(series).map(([k, v]) => [k, stat(v)])),
  committedAt, notCommitted: appIds.filter((id) => !committedAt[id]),
  flushes,
  worker,
};
const h = result.probes.health;
const d = result.probes.dbq;
const gates = {
  health_p99_lt_250: h.p99 < 250,
  health_max_lt_1000: h.max < 1000,
  health_no_failures: h.fails === 0,
  dbq_p99_lt_500: d.p99 < 500,
  all_committed: result.notCommitted.length === 0,
  // Commit time alone can come from startup catch-up — require a flush record per app.
  every_app_flushed_ok: appIds.every((id) => okFlushApps.has(id)),
  // ...and the writer upload must have run in the publish worker, not the gateway.
  every_app_via_worker: appIds.every((id) => workerApps.has(id)),
  worker_no_crash: (worker?.restarts ?? 0) === restartsBefore,
};
const pass = Object.values(gates).every(Boolean);
fs.writeFileSync(`/tmp/heavy-load-${label}.json`, JSON.stringify({ ...result, gates, pass }, null, 2));
console.log(JSON.stringify({ ...result, flushes: flushes.length, gates, pass }, null, 2));
process.exit(pass ? 0 : 1);
