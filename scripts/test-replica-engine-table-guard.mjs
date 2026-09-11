/**
 * Engine-table precondition tests.
 *
 * Runs under Electron: better-sqlite3 is built against Electron's ABI and fails with
 * ERR_DLOPEN_FAILED under plain Node.
 *
 *   npm run test:engine-table-guard
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";

const {
  inspectReplicaEngineTables,
  repairReplicaEngineTables,
  describeReplicaEngineTableDefects,
} = await import("../dist/gateway/services/tursoReplica/replicaEngineTableGuard.js");

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-engine-guard-"));
let dbCounter = 0;

/** Build a throwaway SQLite file, run `setup` against it, return its path. */
function makeDb(setup) {
  const dbPath = path.join(tmpRoot, `case-${(dbCounter += 1)}.db`);
  const db = new Database(dbPath);
  try {
    setup(db);
  } finally {
    db.close();
  }
  return dbPath;
}

function tableNames(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

console.log("\n== the shape that aborted the sync worker ==");
{
  // Verbatim from papr-books at the time of the 2026-09-10 crash.
  const dbPath = makeDb((db) => {
    db.exec(
      'CREATE TABLE "turso_sync_last_change_id" ' +
        '("client_id" TEXT, "pull_gen" TEXT, "change_id" TEXT)',
    );
    db.exec("CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT)");
    db.exec("INSERT INTO books VALUES ('b1', 'Dune')");
  });

  const defects = inspectReplicaEngineTables(dbPath);
  check("detects the index-free engine table", defects.length === 1, JSON.stringify(defects));
  check(
    "names the table and reason",
    defects[0]?.table === "turso_sync_last_change_id" &&
      defects[0]?.reason === "missing_unique_index",
  );
  check(
    "describes it for the log",
    describeReplicaEngineTableDefects(defects).includes("turso_sync_last_change_id"),
  );

  const dropped = repairReplicaEngineTables(dbPath);
  check("repair drops it", dropped.includes("turso_sync_last_change_id"));
  check(
    "table is gone so the engine can rebuild it",
    !tableNames(dbPath).includes("turso_sync_last_change_id"),
  );
  check("app table survives repair", tableNames(dbPath).includes("books"));

  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT title FROM books WHERE id='b1'").get();
  db.close();
  check("app rows survive repair", row?.title === "Dune");

  check("clean after repair", inspectReplicaEngineTables(dbPath).length === 0);
}

console.log("\n== the healthy shape is left alone ==");
{
  const dbPath = makeDb((db) => {
    db.exec(
      "CREATE TABLE turso_sync_last_change_id " +
        "(client_id TEXT PRIMARY KEY, pull_gen INTEGER, change_id INTEGER)",
    );
  });
  check("no defect on a TEXT PRIMARY KEY table", inspectReplicaEngineTables(dbPath).length === 0);
  check("repair is a no-op", repairReplicaEngineTables(dbPath).length === 0);
  check(
    "healthy table is not dropped",
    tableNames(dbPath).includes("turso_sync_last_change_id"),
  );
}

console.log("\n== turso_cdc must NOT be flagged (the false-positive trap) ==");
{
  // Its key is `change_id INTEGER PRIMARY KEY AUTOINCREMENT` — the rowid, so SQLite
  // creates no separate index. A general "no unique index" rule would drop a healthy
  // table here, which is why the check is restricted to specific tables.
  const dbPath = makeDb((db) => {
    db.exec(
      "CREATE TABLE turso_cdc (change_id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        'change_time INTEGER, change_type INTEGER, table_name TEXT, id, "before" BLOB)',
    );
  });
  check("turso_cdc with a rowid key is healthy", inspectReplicaEngineTables(dbPath).length === 0);
  check("turso_cdc is never dropped", repairReplicaEngineTables(dbPath).length === 0);
  check("turso_cdc still present", tableNames(dbPath).includes("turso_cdc"));
}

console.log("\n== turso_cdc_version ==");
{
  const bad = makeDb((db) => {
    db.exec('CREATE TABLE "turso_cdc_version" ("version" TEXT)');
  });
  check("index-free turso_cdc_version is a defect", inspectReplicaEngineTables(bad).length === 1);

  const good = makeDb((db) => {
    db.exec("CREATE TABLE turso_cdc_version (version TEXT PRIMARY KEY)");
  });
  check("keyed turso_cdc_version is healthy", inspectReplicaEngineTables(good).length === 0);
}

console.log("\n== absence and edge cases ==");
{
  const noEngineTables = makeDb((db) => {
    db.exec("CREATE TABLE books (id TEXT PRIMARY KEY)");
  });
  check(
    "absent engine tables are fine — the engine creates them",
    inspectReplicaEngineTables(noEngineTables).length === 0,
  );

  check(
    "missing file is not a defect",
    inspectReplicaEngineTables(path.join(tmpRoot, "does-not-exist.db")).length === 0,
  );

  const empty = path.join(tmpRoot, "empty.db");
  fs.writeFileSync(empty, "");
  check("zero-byte file is not a defect", inspectReplicaEngineTables(empty).length === 0);

  const garbage = path.join(tmpRoot, "garbage.db");
  fs.writeFileSync(garbage, "this is not a database");
  check(
    "unreadable file is left alone rather than guessed at",
    inspectReplicaEngineTables(garbage).length === 0,
  );
}

console.log("\n== both defects in one file ==");
{
  const dbPath = makeDb((db) => {
    db.exec('CREATE TABLE "turso_sync_last_change_id" ("client_id" TEXT)');
    db.exec('CREATE TABLE "turso_cdc_version" ("version" TEXT)');
    db.exec("CREATE TABLE notes (id TEXT PRIMARY KEY)");
  });
  check("detects both", inspectReplicaEngineTables(dbPath).length === 2);
  const dropped = repairReplicaEngineTables(dbPath);
  check("drops both", dropped.length === 2);
  check("app table untouched", tableNames(dbPath).includes("notes"));
}

console.log("\n== legacy vs live classification of the engine's tables ==");
{
  const {
    isLegacySyncPathTable,
    isReplicaEngineOwnedTable,
    listLegacySyncPathTablesForPath,
    stripLegacySyncPathArtifacts,
  } = await import("../dist/gateway/services/legacyCdcArtifacts.js");

  check(
    "engine-owned set covers the three live tables",
    isReplicaEngineOwnedTable("turso_cdc") &&
      isReplicaEngineOwnedTable("turso_cdc_version") &&
      isReplicaEngineOwnedTable("turso_sync_last_change_id"),
  );
  check(
    "genuine legacy names are not engine-owned",
    !isReplicaEngineOwnedTable("turso_sync_log") &&
      !isReplicaEngineOwnedTable("_papr_sync_log") &&
      !isReplicaEngineOwnedTable("_papr_sync_meta"),
  );

  // Default (pre-cutover) reading is unchanged, so cutover and provision still strip.
  check(
    "without the option they still read as legacy (cutover behaviour preserved)",
    isLegacySyncPathTable("turso_cdc") &&
      isLegacySyncPathTable("turso_sync_last_change_id"),
  );
  check(
    "with preserveEngineTables they are live",
    !isLegacySyncPathTable("turso_cdc", { preserveEngineTables: true }) &&
      !isLegacySyncPathTable("turso_sync_last_change_id", {
        preserveEngineTables: true,
      }),
  );
  check(
    "preserveEngineTables does not rescue real legacy debris",
    isLegacySyncPathTable("_papr_sync_log", { preserveEngineTables: true }) &&
      isLegacySyncPathTable("turso_sync_log", { preserveEngineTables: true }) &&
      isLegacySyncPathTable("_papr_sync_meta", { preserveEngineTables: true }),
  );
  check(
    "migration ledgers are never legacy either way",
    !isLegacySyncPathTable("schema_migrations", { preserveEngineTables: true }) &&
      !isLegacySyncPathTable("_papr_schema_migrations"),
  );

  // The startup purge's short-circuit: a healthy replica must look clean, or it gets
  // closed, purged, and re-pulled on every launch.
  const healthyReplica = makeDb((db) => {
    db.exec(
      "CREATE TABLE turso_sync_last_change_id " +
        "(client_id TEXT PRIMARY KEY, pull_gen INTEGER, change_id INTEGER)",
    );
    db.exec("CREATE TABLE turso_cdc (change_id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.exec("CREATE TABLE turso_cdc_version (version TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT)");
    db.exec("INSERT INTO books VALUES ('b1', 'Dune')");
  });

  check(
    "healthy replica reports no legacy tables (purge short-circuits)",
    listLegacySyncPathTablesForPath(healthyReplica, { preserveEngineTables: true })
      .length === 0,
  );
  check(
    "…and would have reported three without the option (the old behaviour)",
    listLegacySyncPathTablesForPath(healthyReplica).length === 3,
  );
  check(
    "strip is a no-op on a healthy replica",
    stripLegacySyncPathArtifacts(healthyReplica, { preserveEngineTables: true })
      .length === 0,
  );
  check(
    "engine tables survive the startup purge",
    ["turso_cdc", "turso_cdc_version", "turso_sync_last_change_id"].every((t) =>
      tableNames(healthyReplica).includes(t),
    ),
  );

  // Real debris alongside live engine tables: drop the debris, keep the engine's.
  const mixed = makeDb((db) => {
    db.exec(
      "CREATE TABLE turso_sync_last_change_id " +
        "(client_id TEXT PRIMARY KEY, pull_gen INTEGER, change_id INTEGER)",
    );
    db.exec("CREATE TABLE _papr_sync_log (id TEXT, table_name TEXT)");
    db.exec("CREATE TABLE _papr_sync_meta (id TEXT)");
    db.exec("CREATE TABLE books (id TEXT PRIMARY KEY)");
  });
  const droppedMixed = stripLegacySyncPathArtifacts(mixed, {
    preserveEngineTables: true,
  });
  check(
    "drops the legacy tables",
    droppedMixed.includes("_papr_sync_log") && droppedMixed.includes("_papr_sync_meta"),
  );
  check(
    "keeps the engine table",
    !droppedMixed.includes("turso_sync_last_change_id") &&
      tableNames(mixed).includes("turso_sync_last_change_id"),
  );
  check("keeps app tables", tableNames(mixed).includes("books"));
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
