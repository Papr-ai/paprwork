/**
 * Replays the 2026-09-24 incident against the real replica migration runner
 * and the real verifier, with node:sqlite standing in for the Turso replica
 * handle (better-sqlite3 is built for Electron's ABI and does not load here).
 *
 * The incident: a telemetry DB's 0002 migration was a copy-and-swap rebuild.
 * It was recorded in `_papr_schema_migrations` (papr_db tools), but the
 * replica-local `schema_migrations` row was gone, so before each job run the
 * runner -- which read only `schema_migrations` -- applied 0002 again. The
 * re-runs emptied the live tables in the replica and in Turso.
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

const nodeRequire = createRequire(import.meta.url);

function openMemoryDb(): Sqlite | null {
  try {
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (location: string) => Sqlite;
    };
    return new DatabaseSync(":memory:");
  } catch {
    return null;
  }
}

const canUseNodeSqlite = openMemoryDb() !== null;

const INIT = `
CREATE TABLE IF NOT EXISTS step (run_id TEXT NOT NULL, step INTEGER NOT NULL, loss REAL, PRIMARY KEY (run_id, step));
CREATE TABLE IF NOT EXISTS health (ts TEXT PRIMARY KEY, status TEXT);
CREATE TABLE IF NOT EXISTS gpu (ts TEXT NOT NULL, idx INTEGER NOT NULL, power REAL, PRIMARY KEY (ts, idx));
`;

/** Copy-and-swap rebuilds: the shape of the migration that emptied the DB. */
const REBUILD = `
CREATE TABLE IF NOT EXISTS runs (run TEXT PRIMARY KEY, label TEXT);
INSERT OR IGNORE INTO runs (run, label) VALUES ('0.6b', '0.6B');
ALTER TABLE step ADD COLUMN run TEXT NOT NULL DEFAULT '0.6b';
CREATE TABLE health_v2 (ts TEXT NOT NULL, run TEXT NOT NULL DEFAULT '0.6b', status TEXT, PRIMARY KEY (run, ts));
INSERT INTO health_v2 (ts, run, status) SELECT ts, '0.6b', status FROM health;
DROP TABLE health;
ALTER TABLE health_v2 RENAME TO health;
CREATE TABLE gpu_v2 (ts TEXT NOT NULL, run TEXT NOT NULL DEFAULT '0.6b', idx INTEGER NOT NULL, power REAL, PRIMARY KEY (run, ts, idx));
INSERT INTO gpu_v2 (ts, run, idx, power) SELECT ts, '0.6b', idx, power FROM gpu;
DROP TABLE gpu;
ALTER TABLE gpu_v2 RENAME TO gpu;
CREATE INDEX IF NOT EXISTS idx_health_run_ts ON health (run, ts);
`;

/** Drop-and-recreate: verifies as satisfied once applied, and a re-run empties the table. */
const RECREATE = `
DROP TABLE IF EXISTS gpu;
CREATE TABLE gpu (ts TEXT NOT NULL, run TEXT NOT NULL, idx INTEGER NOT NULL, power REAL, PRIMARY KEY (run, ts, idx));
`;

const ADDITIVE_NOTES = `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT);`;

interface Harness {
  db: Sqlite;
  root: string;
  dbPath: string;
  applyCalls: string[];
  warnings: string[];
  failLedgerReads: boolean;
}

let harness: Harness | null = null;

function makeHarness(migrations: Record<string, string>): Harness {
  const db = openMemoryDb() as Sqlite;
  const root = mkdtempSync(path.join(tmpdir(), "replica-rerun-"));
  mkdirSync(path.join(root, "migrations"));
  for (const [id, sql] of Object.entries(migrations)) {
    writeFileSync(path.join(root, "migrations", `${id}.sql`), sql);
  }
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT);
    CREATE TABLE _papr_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT, source TEXT, content_hash TEXT);
  `);
  harness = {
    db,
    root,
    dbPath: path.join(root, "data.db"),
    applyCalls: [],
    warnings: [],
    failLedgerReads: false,
  };
  return harness;
}

function record(h: Harness, table: string, ...ids: string[]): void {
  for (const id of ids) {
    h.db.prepare(`INSERT OR IGNORE INTO ${table} (id) VALUES (?)`).run(id);
  }
}

function count(h: Harness, table: string): number {
  return Number(h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all()[0].n);
}

function seedTelemetry(h: Harness): void {
  for (let i = 0; i < 3; i += 1) {
    h.db.prepare("INSERT INTO health (ts, status) VALUES (?, 'ok')").run(`2026-09-23T22:0${i}:00Z`);
  }
  for (let idx = 0; idx < 8; idx += 1) {
    h.db.prepare("INSERT INTO gpu (ts, idx, power) VALUES ('2026-09-23T22:00:00Z', ?, 600)").run(idx);
  }
}

async function runRunner(h: Harness): Promise<string[]> {
  vi.resetModules();
  vi.doMock("../src/gateway/services/DatabaseRegistryService.js", () => ({
    getDatabaseRegistryService: () => ({
      getByPath: () => ({
        dbId: "db-telemetry",
        label: "Stage A Training Telemetry",
        localPath: h.dbPath,
        createdAt: "2026-09-22T04:31:20Z",
      }),
    }),
  }));
  vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
    queryLinkedDbViaTursoReplica: async (
      _source: unknown,
      sql: string,
      params: unknown[] = [],
    ) => {
      if (h.failLedgerReads && /schema_migrations/.test(sql)) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return { rows: h.db.prepare(sql).all(...params) };
    },
  }));
  vi.doMock("../src/gateway/services/tursoReplica/PaprDbService.js", () => ({
    paprDbApplyMigration: async ({ migrationId }: { migrationId: string }) => {
      h.applyCalls.push(migrationId);
      h.db.exec(readFileSync(path.join(h.root, "migrations", migrationId), "utf8"));
      record(h, "schema_migrations", migrationId.replace(/\.sql$/, ""));
      return { applied: true, migrationId, pendingPush: false, backend: "turso-replica" };
    },
  }));
  const { applyReplicaRegistryDatabaseMigrations } = await import(
    "../src/gateway/services/tursoReplica/tursoReplicaRegistryMigrations.js"
  );
  return applyReplicaRegistryDatabaseMigrations(h.root, h.dbPath, {
    onWarning: (message: string) => h.warnings.push(message),
  });
}

describe.skipIf(!canUseNodeSqlite)("replica migration runner: re-run safety", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.doUnmock("../src/gateway/services/DatabaseRegistryService.js");
    vi.doUnmock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js");
    vi.doUnmock("../src/gateway/services/tursoReplica/PaprDbService.js");
    vi.resetModules();
    vi.restoreAllMocks();
    if (harness) {
      harness.db.close();
      rmSync(harness.root, { recursive: true, force: true });
      harness = null;
    }
  });

  it("2026-09-24 replay: a migration recorded only in _papr_schema_migrations is not run again", async () => {
    const h = makeHarness({ "0001_init": INIT, "0002_multi_run": REBUILD });
    h.db.exec(INIT);
    seedTelemetry(h);
    h.db.exec(REBUILD);
    // The replica-local row for 0002 is gone; the Turso-side ledger still has it.
    record(h, "schema_migrations", "0001_init");
    record(h, "_papr_schema_migrations", "0001_init", "0002_multi_run");

    await expect(runRunner(h)).resolves.toEqual([]);
    expect(h.applyCalls).toEqual([]);
    expect(count(h, "health")).toBe(3);
    expect(count(h, "gpu")).toBe(8);
  });

  it("does not re-run a drop-and-recreate that would empty the table", async () => {
    const h = makeHarness({ "0001_init": INIT, "0002_recreate_gpu": RECREATE });
    h.db.exec(INIT);
    h.db.exec(RECREATE);
    for (let idx = 0; idx < 8; idx += 1) {
      h.db.prepare("INSERT INTO gpu (ts, run, idx, power) VALUES ('t', '4b', ?, 600)").run(idx);
    }
    record(h, "schema_migrations", "0001_init");
    record(h, "_papr_schema_migrations", "0001_init", "0002_recreate_gpu");

    // Control: running it again really would lose the rows.
    const control = openMemoryDb() as Sqlite;
    control.exec(INIT + RECREATE);
    control.prepare("INSERT INTO gpu (ts, run, idx, power) VALUES ('t', '4b', 0, 600)").run();
    control.exec(RECREATE);
    expect(Number(control.prepare("SELECT COUNT(*) AS n FROM gpu").all()[0].n)).toBe(0);
    control.close();

    await expect(runRunner(h)).resolves.toEqual([]);
    expect(h.applyCalls).toEqual([]);
    expect(count(h, "gpu")).toBe(8);
  });

  it("refuses to re-run a recorded destructive migration whose schema drifted, and says so", async () => {
    const h = makeHarness({ "0001_init": INIT, "0002_multi_run": REBUILD });
    h.db.exec(INIT);
    seedTelemetry(h);
    h.db.exec(REBUILD);
    record(h, "schema_migrations", "0001_init", "0002_multi_run");
    h.db.exec("DROP INDEX idx_health_run_ts"); // drift: verification now fails

    await expect(runRunner(h)).resolves.toEqual([]);
    expect(h.applyCalls).toEqual([]);
    expect(count(h, "health")).toBe(3);
    expect(h.warnings.join("\n")).toMatch(/NOT re-running 0002_multi_run .*DROP TABLE health/);
  });

  it("still repairs drift by re-applying an additive migration", async () => {
    const h = makeHarness({ "0001_init": INIT });
    h.db.exec(INIT);
    record(h, "schema_migrations", "0001_init");
    h.db.exec("DROP TABLE gpu");

    await expect(runRunner(h)).resolves.toEqual(["0001_init.sql"]);
    expect(count(h, "gpu")).toBe(0); // table is back
    expect(h.warnings.join("\n")).toMatch(/re-applying/);
  });

  it("with an unreadable ledger: holds destructive migrations, applies additive ones", async () => {
    const h = makeHarness({
      "0001_init": INIT,
      "0002_multi_run": REBUILD,
      "0003_notes": ADDITIVE_NOTES,
    });
    h.db.exec(INIT);
    seedTelemetry(h);
    record(h, "schema_migrations", "0001_init");
    h.failLedgerReads = true;

    await expect(runRunner(h)).resolves.toEqual(["0003_notes.sql"]);
    expect(h.applyCalls).toEqual(["0003_notes.sql"]);
    expect(count(h, "health")).toBe(3);
    const log = h.warnings.join("\n");
    expect(log).toMatch(/Could not read the migration ledger/);
    expect(log).toMatch(/NOT re-running 0002_multi_run/);
  });

  it("runs a pending destructive migration exactly once on a readable ledger", async () => {
    const h = makeHarness({ "0001_init": INIT, "0002_multi_run": REBUILD });
    h.db.exec(INIT);
    seedTelemetry(h);
    record(h, "schema_migrations", "0001_init");

    await expect(runRunner(h)).resolves.toEqual(["0002_multi_run.sql"]);
    expect(count(h, "health")).toBe(3); // copied across by the rebuild
    await expect(runRunner(h)).resolves.toEqual([]);
    expect(h.applyCalls).toEqual(["0002_multi_run.sql"]);
  });
});
