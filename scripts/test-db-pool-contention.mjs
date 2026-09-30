/**
 * Head-of-line blocking in the mini-app SQLite worker pool.
 *
 * Runs under Electron: better-sqlite3 is built against Electron's ABI and fails
 * with ERR_DLOPEN_FAILED under plain Node.
 *
 *   npm run test:db-pool-contention
 *
 * The defect: the pool has two worker threads, each running one synchronous
 * better-sqlite3 call at a time, and the wait for a contended file happened
 * inside that call. Enough blocked requests from one app therefore occupied
 * every thread for the whole timeout, and a second app's queries — against a
 * completely different, uncontended file — queued behind them.
 *
 * This holds a real exclusive lock on one app's database and measures whether a
 * second app still gets served, then whether the contended app recovers rather
 * than handing "database is locked" to its UI.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";

const { initializeDbPool } = await import(
  "../dist/gateway/services/DbQueryPool.js"
);

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function seed(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE rows_t (id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO rows_t (v) VALUES (?)").run("seeded");
  db.close();
}

/**
 * Hold a lock that genuinely blocks readers.
 *
 * WAL lets readers run alongside a writer, so an ordinary transaction would not
 * reproduce anything. `locking_mode = EXCLUSIVE` takes the file lock outright,
 * which is what a checkpoint or a VACUUM does — the class of holder that shows
 * up in production logs next to these errors.
 */
function holdExclusiveLock(dbPath, holdMs) {
  const db = new Database(dbPath);
  db.pragma("locking_mode = EXCLUSIVE");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO rows_t (v) VALUES (?)").run("holder");
  const release = () => {
    try {
      db.exec("COMMIT");
    } catch {
      /* already gone */
    }
    db.close();
  };
  const timer = setTimeout(release, holdMs);
  return () => {
    clearTimeout(timer);
    release();
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-db-pool-"));
const contended = path.join(tmp, "contended.db");
const free = path.join(tmp, "free.db");
seed(contended);
seed(free);

const workerUrl = pathToFileURL(
  path.resolve("dist/gateway/workers/db-query-worker.js"),
);
const pool = initializeDbPool(workerUrl);

console.log("\nPool contention\n");

// Confirm the lock really does block a reader on this platform, otherwise every
// assertion below would pass against an uncontended file and prove nothing.
{
  const release = holdExclusiveLock(contended, 5_000);
  let blocked = false;
  try {
    const probe = new Database(contended, { readonly: true, timeout: 50 });
    probe.prepare("SELECT 1").get();
    probe.close();
  } catch (err) {
    blocked = /database is locked|SQLITE_BUSY/i.test(String(err));
  }
  release();
  check(
    "the exclusive lock actually blocks a reader (guards the guard)",
    blocked,
    "reads were not blocked, so this test cannot detect the defect",
  );
}

// The real shape: one app's requests fill every worker while its file is locked,
// and a second app queries a different file that is perfectly free.
{
  const HOLD_MS = 2_000;
  const release = holdExclusiveLock(contended, HOLD_MS);

  const startedAt = Date.now();
  const appA = [];
  for (let i = 0; i < 4; i++) {
    appA.push(
      pool
        .query("app-A", contended, "SELECT * FROM rows_t")
        .then(() => ({ ok: true, ms: Date.now() - startedAt }))
        .catch((err) => ({ ok: false, error: String(err) })),
    );
  }

  // Give app A time to claim both threads before app B asks for anything.
  await new Promise((r) => setTimeout(r, 50));

  const bStartedAt = Date.now();
  const appB = await pool
    .query("app-B", free, "SELECT * FROM rows_t")
    .then((res) => ({ ok: true, ms: Date.now() - bStartedAt, rows: res.count }))
    .catch((err) => ({ ok: false, error: String(err) }));

  const bLatency = appB.ms ?? -1;
  check(
    "a second app is served while the first app's file is locked",
    appB.ok,
    appB.error,
  );
  check(
    `that app is not made to wait out the lock (${bLatency}ms < ${HOLD_MS}ms)`,
    appB.ok && bLatency < HOLD_MS / 2,
    `waited ${bLatency}ms with the lock held for ${HOLD_MS}ms — the worker was still pinned`,
  );

  const results = await Promise.all(appA);
  release();

  const recovered = results.filter((r) => r.ok).length;
  check(
    `the contended app recovers instead of erroring (${recovered}/4 succeeded)`,
    recovered === 4,
    results
      .filter((r) => !r.ok)
      .map((r) => r.error)
      .join("; "),
  );
  check(
    "and it waited for the lock rather than failing fast",
    results.every((r) => !r.ok || r.ms >= HOLD_MS * 0.5),
    "recovery was suspiciously quick — the lock may not have been held",
  );
}

// The reported failure: a read handed "database is locked" to the app. The old
// in-worker wait was 3s, so any holder past that failed outright; the budget now
// reaches ~5s, which is what a write already had.
{
  const HOLD_MS = 3_600;
  const release = holdExclusiveLock(contended, HOLD_MS);
  const startedAt = Date.now();
  const outcome = await pool
    .query("app-D", contended, "SELECT * FROM rows_t")
    .then((res) => ({ ok: true, ms: Date.now() - startedAt, rows: res.count }))
    .catch((err) => ({ ok: false, error: String(err) }));
  release();

  check(
    `a read survives a lock past the old 3s timeout (${outcome.ms ?? "-"}ms)`,
    outcome.ok,
    outcome.error,
  );
}

// A lock that outlives the retry budget must still be reported, not masked.
{
  const release = holdExclusiveLock(contended, 30_000);
  const outcome = await pool
    .query("app-C", contended, "SELECT * FROM rows_t")
    .then(() => ({ ok: true }))
    .catch((err) => ({ ok: false, error: String(err) }));
  release();

  check(
    "a lock that outlasts the budget is reported as a lock",
    !outcome.ok && /database is locked|SQLITE_BUSY/i.test(outcome.error ?? ""),
    outcome.ok ? "unexpectedly succeeded" : outcome.error,
  );
}

pool.terminate();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
