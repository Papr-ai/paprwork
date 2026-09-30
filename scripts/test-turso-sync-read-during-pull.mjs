#!/usr/bin/env node
/**
 * Experiment: concurrent local reads vs in-flight pull() on one @tursodatabase/sync handle,
 * and Papr's per-path worker queue (interactive query vs background pull).
 *
 * Requires Papr Memory / Turso (same as spike-turso-embedded-replica).
 *
 * Usage:
 *   npm run test:turso-read-during-pull
 *   npm run build:gateway && npm run test:turso-read-during-pull
 */

import { connect } from "@tursodatabase/sync";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvLocal, resolveMemoryAccess } from "./lib/testEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(msg) {
  console.log(msg);
}

function cleanup(base) {
  for (const suffix of ["", "-wal", "-shm", "-info"]) {
    try {
      fs.unlinkSync(base + suffix);
    } catch {
      // ignore
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveCloudBase() {
  loadEnvLocal();
  const access = await resolveMemoryAccess();
  if (!access) {
    throw new Error("No Papr Memory access — set PAPR_API_KEY or run Papr Work logged in");
  }
  if (access.mode === "gateway") {
    return access.cloudBase;
  }
  return `${access.memoryBase}/v1/cloud`;
}

async function fetchToken(cloudBase, dbName) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.PAPR_API_KEY?.trim()) {
    headers["X-API-Key"] = process.env.PAPR_API_KEY.trim();
  }
  const res = await fetch(`${cloudBase}/databases/token`, {
    method: "POST",
    headers,
    body: JSON.stringify({ database: dbName }),
  });
  if (!res.ok) {
    throw new Error(`token ${dbName} (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.tursoUrl || !data.authToken) {
    throw new Error(`token response missing fields for ${dbName}`);
  }
  return { tursoUrl: data.tursoUrl, authToken: data.authToken };
}

async function connectDb(opts) {
  const db = await connect(opts);
  await db.connect();
  return db;
}

async function timedRead(db, label) {
  const t0 = performance.now();
  const stmt = await db.prepare("SELECT COUNT(*) AS c FROM probe");
  const rows = await stmt.all();
  const ms = Math.round(performance.now() - t0);
  const c = rows[0]?.c ?? rows[0]?.[0];
  return { label, ms, c: Number(c) };
}

async function runSdkExperiment(tursoUrl, authToken, localPath) {
  log("\n--- A) SDK: one handle, 12 concurrent SELECTs (no pull) ---");
  const db = await connectDb({
    path: localPath,
    url: tursoUrl,
    authToken,
    bootstrapIfEmpty: true,
  });
  await db.exec(
    "CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
  );
  await db.exec("DELETE FROM probe");
  await db.exec("INSERT INTO probe (n) VALUES (1),(2),(3)");
  await db.push();

  const concurrent = await Promise.all(
    Array.from({ length: 12 }, (_, i) => timedRead(db, `read-${i + 1}`)),
  );
  const maxMs = Math.max(...concurrent.map((r) => r.ms));
  const sumMs = concurrent.reduce((a, r) => a + r.ms, 0);
  log(`  wall for Promise.all: ${Math.round(performance.now())} (see per-read ms)`);
  for (const r of concurrent) {
    log(`    ${r.label}: ${r.ms}ms count=${r.c}`);
  }
  log(
    `  → If reads were fully parallel on separate connections, max≈one read; ` +
      `on one handle execLock serializes: max=${maxMs}ms sum=${sumMs}ms`,
  );

  log("\n--- B) SDK: pull (long poll) + 8 concurrent SELECTs on same handle ---");
  const pullStarted = performance.now();
  const pullPromise = db
    .pull()
    .then((changed) => ({
      ok: true,
      changed,
      ms: Math.round(performance.now() - pullStarted),
    }))
    .catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ms: Math.round(performance.now() - pullStarted),
    }));

  await sleep(5);
  const readsDuringPull = await Promise.all(
    Array.from({ length: 8 }, (_, i) => timedRead(db, `during-pull-${i + 1}`)),
  );
  const pullResult = await pullPromise;

  log(`  pull finished: ok=${pullResult.ok} changed=${pullResult.changed ?? "?"} ${pullResult.ms}ms`);
  if (!pullResult.ok) {
    log(`  pull error: ${pullResult.error}`);
  }
  for (const r of readsDuringPull) {
    log(`    ${r.label}: ${r.ms}ms count=${r.c}`);
  }
  const readMax = Math.max(...readsDuringPull.map((r) => r.ms));
  log(
    `  → Reads during pull max=${readMax}ms. ` +
      `If max is small while pull took ${pullResult.ms}ms, SDK interleaves (long-poll does not block reads). ` +
      `If max ≈ pull time, reads waited on sync.`,
  );

  await db.close();
}

async function runPaprWorkerExperiment(tursoUrl, authToken, localPath) {
  log("\n--- C) Papr worker core: background pull then interactive query (same path) ---");
  const corePath = path.join(
    __dirname,
    "../dist/gateway/services/tursoReplica/tursoReplicaSyncWorkerCore.js",
  );
  if (!fs.existsSync(corePath)) {
    log("  ⏭️  skip — run npm run build:gateway first");
    return;
  }
  const { TursoSyncWorkerCore } = await import(pathToFileURL(corePath).href);
  const core = new TursoSyncWorkerCore();

  const openSpec = {
    localPath,
    tursoUrl,
    authToken,
    bootstrapIfEmpty: false,
  };

  await core.run({
    id: "connect",
    op: "connect",
    ...openSpec,
  });

  const pullEnqueue = performance.now();
  const pullPromise = core.run({
    id: "pull-bg",
    op: "pull",
    ...openSpec,
  });

  await sleep(10);

  const queryStarted = performance.now();
  const queryPromise = core.run({
    id: "q1",
    op: "query",
    sql: "SELECT COUNT(*) AS c FROM probe",
    params: [],
    ...openSpec,
  });

  const [pullRes, queryRes] = await Promise.all([pullPromise, queryPromise]);
  const pullMs = Math.round(performance.now() - pullEnqueue);
  const queryMs = Math.round(performance.now() - queryStarted);

  const queueMs = queryRes.opTiming?.queueMs ?? -1;
  const execMs = queryRes.opTiming?.execMs ?? -1;
  log(`  pull wall=${pullMs}ms pulled=${Boolean(pullRes.result?.pulled)}`);
  log(`  query wall=${queryMs}ms queueMs=${queueMs} execMs=${execMs}`);
  log(
    queueMs > 50
      ? `  → Papr path scheduler: query waited ${queueMs}ms behind active/queued pull.`
      : `  → Papr path scheduler: query queueMs=${queueMs} (little/no wait).`,
  );

  await core.run({ id: "close", op: "close", ...openSpec });
}

async function main() {
  log("=== Turso sync: read vs pull concurrency experiment ===\n");

  const cloudBase = await resolveCloudBase();
  log(`Cloud API: ${cloudBase}`);

  const dbName = `read-pull-exp-${Date.now().toString(36)}`;
  const { tursoUrl, authToken } = await fetchToken(cloudBase, dbName);
  const localPath = path.join(os.tmpdir(), `${dbName}.db`);
  cleanup(localPath);

  try {
    await runSdkExperiment(tursoUrl, authToken, localPath);
    await runPaprWorkerExperiment(tursoUrl, authToken, localPath);
  } finally {
    cleanup(localPath);
  }

  log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
