/**
 * 2026-11, Website Audit: its 0001_baseline.sql holds every CREATE TABLE. On a
 * fresh cloud-synced (replica) database, setup wrote the 0001_baseline ledger row
 * before any migration ran, so the baseline was "applied" without running and
 * 0002 failed with "no such table: audits". Every Community install failed.
 *
 * Only the engine layer (tursoReplicaRouting) is faked, with node:sqlite.
 * Setup (ensureReplicaSchemaMigrationsLedger), the replica runner and the
 * per-migration apply are the real code.
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[]; run(...p: unknown[]): unknown };
  close(): void;
}
const nodeRequire = createRequire(import.meta.url);
function openMemoryDb(): Sqlite | null {
  try {
    const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: new (l: string) => Sqlite };
    return new DatabaseSync(":memory:");
  } catch {
    return null;
  }
}
const canUseNodeSqlite = openMemoryDb() !== null;

// Website Audit's published migrations, trimmed to the shape that matters.
const BASELINE_WITH_SCHEMA = `-- GTM Foundations Audit registry schema (baseline)
CREATE TABLE IF NOT EXISTS audits (id TEXT PRIMARY KEY, company_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS audit_modules (id TEXT PRIMARY KEY, audit_id TEXT NOT NULL, score INTEGER);
`;
const ADD_CONTACT = "ALTER TABLE audits ADD COLUMN contact_name TEXT;\nALTER TABLE audits ADD COLUMN contact_email TEXT;\n";
const ADD_NEXT_STEPS = "CREATE TABLE IF NOT EXISTS audit_next_steps (id TEXT PRIMARY KEY, audit_id TEXT NOT NULL);\n";

const R = "../../../src/gateway/services";
const MOCKED = [
  `${R}/DatabaseRegistryService.js`,
  "../../../src/gateway/utils/tursoReplicaEnabled.js",
  `${R}/tursoReplica/tursoReplicaRouting.js`,
  `${R}/tursoReplica/PaprDbService.js`,
];

interface Harness { db: Sqlite; base: string; root: string; dbPath: string; executed: string[] }
let h: Harness | null = null;

function makeHarness(migrations: Record<string, string>): Harness {
  const db = openMemoryDb() as Sqlite;
  const base = mkdtempSync(path.join(tmpdir(), "replica-baseline-"));
  // Registry layout, so the real code resolves the migration root from dbPath.
  const root = path.join(base, "data", "databases", "gtm-audit");
  mkdirSync(path.join(root, "migrations"), { recursive: true });
  for (const [id, sql] of Object.entries(migrations)) {
    writeFileSync(path.join(root, "migrations", `${id}.sql`), sql);
  }
  h = { db, base, root, dbPath: path.join(root, "data.db"), executed: [] };
  return h;
}

const source = (x: Harness) =>
  ({ id: "db-gtm", type: "sqlite", dbId: "db-gtm", alias: "gtm-audit", dbPath: x.dbPath, tables: [], linkedAt: "2026-11-25" }) as never;

function mockEngine(x: Harness): void {
  const run = (sql: string, params: unknown[] = []) => {
    if (params.length) x.db.prepare(sql).run(...params);
    else x.db.exec(sql);
  };
  vi.doMock(`${R}/DatabaseRegistryService.js`, async (orig) => ({
    ...(await orig<object>()),
    getDatabaseRegistryService: () => ({
      getByPath: () => ({ dbId: "db-gtm", label: "Website Audit", localPath: x.dbPath, syncMode: "replica", createdAt: "2026-11-25" }),
    }),
  }));
  vi.doMock("../../../src/gateway/utils/tursoReplicaEnabled.js", async (orig) => ({
    ...(await orig<object>()),
    isTursoReplicaOnline: () => false,
  }));
  vi.doMock(`${R}/tursoReplica/tursoReplicaRouting.js`, async (orig) => ({
    ...(await orig<object>()),
    pullLinkedDbViaTursoReplica: async () => true,
    queryLinkedDbViaTursoReplica: async (_s: unknown, sql: string, params: unknown[] = []) => ({ rows: x.db.prepare(sql).all(...params) }),
    execLinkedDbViaTursoReplica: async (_s: unknown, sql: string) => { run(sql); return { pendingPush: false }; },
    writeLinkedDbViaTursoReplica: async (_s: unknown, sql: string, params: unknown[] = []) => { run(sql, params); return { pendingPush: false, changes: 1 }; },
    // Engine contract: statements + ledger rows in one transaction.
    migrateLinkedDbViaTursoReplica: async (_s: unknown, statements: string[], ledger: Array<{ sql: string; params?: unknown[] }>) => {
      x.db.exec("BEGIN");
      try {
        for (const st of statements) { x.executed.push(st.trim()); x.db.exec(st); }
        for (const l of ledger) run(l.sql, l.params ?? []);
        x.db.exec("COMMIT");
      } catch (e) { x.db.exec("ROLLBACK"); throw e; }
      return { executed: statements, skipped: [], pendingPush: false };
    },
  }));
  // The runner's apply call → the real replica apply (no cloud push in a test).
  vi.doMock(`${R}/tursoReplica/PaprDbService.js`, () => ({
    paprDbApplyMigration: async ({ migrationId }: { migrationId: string }) => {
      const { applyRegistryMigrationOnReplicaOnly } = await import(`${R}/tursoReplica/tursoReplicaMigrationDualApply.js`);
      return { ...(await applyRegistryMigrationOnReplicaOnly(source(x), x.root, migrationId)), backend: "turso-replica" };
    },
  }));
}

async function provision(x: Harness): Promise<void> {
  const { ensureReplicaSchemaMigrationsLedger } = await import(`${R}/tursoReplica/tursoReplicaSchemaLedger.js`);
  await ensureReplicaSchemaMigrationsLedger(source(x));
}

async function runMigrations(x: Harness): Promise<string[]> {
  const { applyReplicaRegistryDatabaseMigrations } = await import(`${R}/tursoReplica/tursoReplicaRegistryMigrations.js`);
  return applyReplicaRegistryDatabaseMigrations(x.root, x.dbPath, {});
}

const appTables = (x: Harness) =>
  x.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY 1").all().map((r) => String(r.name));
const ledger = (x: Harness) => x.db.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map((r) => String(r.id));
const columns = (x: Harness, t: string) => x.db.prepare(`PRAGMA table_info(${t})`).all().map((r) => String(r.name));

describe.skipIf(!canUseNodeSqlite)("replica: 0001_baseline that creates tables", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const m of MOCKED) vi.doUnmock(m);
    vi.resetModules();
    vi.restoreAllMocks();
    if (h) { h.db.close(); rmSync(h.base, { recursive: true, force: true }); h = null; }
  });

  it("fresh install: setup does not pre-record it, the runner applies it, later migrations succeed", async () => {
    const x = makeHarness({ "0001_baseline": BASELINE_WITH_SCHEMA, "0002_add_contact_fields": ADD_CONTACT, "0003_next_steps": ADD_NEXT_STEPS });
    mockEngine(x);
    await provision(x);
    expect(ledger(x)).toEqual([]);

    await expect(runMigrations(x)).resolves.toEqual(["0001_baseline.sql", "0002_add_contact_fields.sql", "0003_next_steps.sql"]);
    expect(appTables(x)).toEqual(["audit_modules", "audit_next_steps", "audits"]);
    expect(columns(x, "audits")).toEqual(expect.arrayContaining(["contact_name", "contact_email"]));
    expect(ledger(x)).toEqual(["0001_baseline", "0002_add_contact_fields", "0003_next_steps"]);
  });

  it("is idempotent: a second run and a later setup call change nothing", async () => {
    const x = makeHarness({ "0001_baseline": BASELINE_WITH_SCHEMA, "0002_add_contact_fields": ADD_CONTACT });
    mockEngine(x);
    await provision(x);
    await runMigrations(x);
    x.executed.length = 0;
    await provision(x);
    await expect(runMigrations(x)).resolves.toEqual([]);
    expect(x.executed).toEqual([]);
    expect(ledger(x)).toEqual(["0001_baseline", "0002_add_contact_fields"]);
  });

  it("existing database (tables already there, baseline unrecorded): recorded, never re-run", async () => {
    const x = makeHarness({ "0001_baseline": BASELINE_WITH_SCHEMA, "0002_add_contact_fields": ADD_CONTACT });
    x.db.exec(BASELINE_WITH_SCHEMA);
    x.db.exec("INSERT INTO audits (id, company_name) VALUES ('a1', 'Acme')");
    mockEngine(x);
    await provision(x);
    expect(ledger(x)).toEqual(["0001_baseline"]);
    await runMigrations(x);
    expect(x.executed.some((s) => /CREATE TABLE IF NOT EXISTS audits/.test(s))).toBe(false);
    expect(Number(x.db.prepare("SELECT COUNT(*) AS n FROM audits").all()[0].n)).toBe(1);
  });

  it("empty placeholder baseline (what Papr writes) is still only a ledger marker", async () => {
    const x = makeHarness({ "0001_baseline": "-- registry database baseline\n", "0002_init": BASELINE_WITH_SCHEMA });
    mockEngine(x);
    await provision(x);
    expect(ledger(x)).toEqual(["0001_baseline"]);
    await expect(runMigrations(x)).resolves.toEqual(["0002_init.sql"]);
    expect(appTables(x)).toEqual(["audit_modules", "audits"]);
  });
});
