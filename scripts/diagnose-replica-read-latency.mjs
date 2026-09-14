#!/usr/bin/env node
/**
 * Compare HTTP wall time for a mini-app replica read vs sync-worker queueMs/execMs.
 * Run while Paprwork gateway is up (default http://127.0.0.1:18789).
 *
 * Usage:
 *   node scripts/diagnose-replica-read-latency.mjs
 *   node scripts/diagnose-replica-read-latency.mjs --app-id=... --source=leads
 */

const GATEWAY = process.env.PAPR_GATEWAY_URL ?? "http://127.0.0.1:18789";
const DEFAULT_APP = "d97ad90c-4188-4636-aec8-abdcbae5f6b4";
const DEFAULT_SOURCE = "leads";

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

async function getTimings() {
  const res = await fetch(`${GATEWAY}/api/debug/turso-worker-timings`);
  if (!res.ok) {
    throw new Error(`timings HTTP ${res.status}`);
  }
  return res.json();
}

async function runQuery(appId, sourceId, sql) {
  const started = performance.now();
  const res = await fetch(`${GATEWAY}/api/db/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, sourceId, sql, params: [] }),
  });
  const wallMs = Math.round(performance.now() - started);
  const body = await res.json();
  return { status: res.status, wallMs, body };
}

function parseTimingLine(line) {
  const m = line.match(
    /op=(\w+).*queueMs=(\d+) execMs=(\d+) opened=(\w+) path=(.+)$/,
  );
  if (!m) {
    return null;
  }
  return {
    op: m[1],
    queueMs: Number(m[2]),
    execMs: Number(m[3]),
    opened: m[4] === "true",
    path: m[5].trim(),
  };
}

async function main() {
  const appId = arg("app-id", DEFAULT_APP);
  const sourceId = arg("source", DEFAULT_SOURCE);
  const sql =
    arg("sql", "SELECT COUNT(*) AS c FROM sqlite_master") ||
    "SELECT 1 AS ok";

  console.log(`Gateway: ${GATEWAY}`);
  console.log(`App: ${appId} source: ${sourceId}`);
  console.log("");

  const before = await getTimings();
  const beforeCount = before.timings?.length ?? 0;

  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await runQuery(appId, sourceId, sql);
    runs.push(r);
    console.log(
      `Query ${i + 1}: HTTP ${r.status} wall=${r.wallMs}ms backend=${r.body?.backend ?? "?"} rows=${r.body?.count ?? r.body?.error ?? "?"}`,
    );
  }

  let phaseTraces = [];
  try {
    const phaseRes = await fetch(`${GATEWAY}/api/debug/replica-read-phases`);
    if (phaseRes.ok) {
      const body = await phaseRes.json();
      phaseTraces = body.traces ?? [];
    }
  } catch {
    /* optional */
  }

  const after = await getTimings();
  const newLines = (after.timings ?? []).slice(beforeCount);
  console.log("");
  console.log("New worker timing lines from this run:");
  if (newLines.length === 0) {
    console.log("  (none — worker may not have logged yet or timings ring truncated)");
  } else {
    for (const line of newLines) {
      const parsed = parseTimingLine(line.replace(/^[^\s]+ /, ""));
      if (parsed) {
        console.log(
          `  op=${parsed.op} queueMs=${parsed.queueMs} execMs=${parsed.execMs} opened=${parsed.opened} path=${parsed.path.split("/").slice(-3).join("/")}`,
        );
      } else {
        console.log(`  ${line}`);
      }
    }
  }

  const workerTotalMs = newLines
    .map((l) => parseTimingLine(l.replace(/^[^\s]+ /, "")))
    .filter(Boolean)
    .map((p) => p.queueMs + p.execMs);

  const maxWorker = workerTotalMs.length ? Math.max(...workerTotalMs) : null;
  const maxWall = Math.max(...runs.map((r) => r.wallMs));

  if (phaseTraces.length > 0) {
    console.log("");
    console.log("Recent replica-read phase traces (gateway):");
    for (const t of phaseTraces.slice(-runs.length)) {
      const parts = Object.entries(t.phases ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}ms`)
        .join(" ");
      console.log(`  total=${t.totalMs}ms ${parts}`);
    }
  }

  console.log("");
  console.log("--- Interpretation ---");
  if (maxWorker !== null && maxWall > 2000 && maxWorker < 50) {
    console.log(
      `Wall time up to ${maxWall}ms but worker queue+exec ≤ ${maxWorker}ms → delay is outside the sync worker`,
    );
    console.log(
      "(gateway event loop / IPC / coalesced wait / credential fetch — not lazy Turso connect on an existing data.db).",
    );
  } else if (maxWorker !== null && maxWorker >= 500) {
    console.log(
      `Worker queue+exec up to ${maxWorker}ms → replica lane busy (push/pull/connect/bootstrap).`,
    );
  } else {
    console.log("Reads look healthy on both HTTP and worker metrics.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
