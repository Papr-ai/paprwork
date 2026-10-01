/**
 * Registry migrations take ONE route: apply once on the replica (statements +
 * both ledger rows in one transaction), then push through sync.
 *
 * Regression for the Enrichment / provider_order incident: the old dual apply
 * ran the migration on the replica (push held) AND again on the Turso primary
 * over HTTP, then pulled. On pull the sync engine replayed the held replica
 * change over the primary's identical copy; a DELETE + INSERT seed into a
 * UNIQUE table failed with "failed to replay local change after remote apply",
 * and the replica's schema_migrations row never reached the cloud.
 *
 * The live half (bottom) runs against a real Turso database when
 * PAPR_LIVE_TURSO_URL / PAPR_LIVE_TURSO_TOKEN are set.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const migrateArgs: Array<{ statements: readonly string[]; ledger: ReadonlyArray<{ sql: string; params?: unknown[] }>; writeOptions?: unknown }> = [];
let pushResult: { ok: boolean; error?: string } = { ok: true };
let online = true;

vi.mock("../src/gateway/utils/tursoReplicaEnabled.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isTursoReplicaOnline: () => online,
}));

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pullLinkedDbViaTursoReplica: vi.fn(async () => { calls.push("pull"); return true; }),
  pushLinkedDbViaTursoReplica: vi.fn(async () => { calls.push("push"); return pushResult; }),
  queryLinkedDbViaTursoReplica: vi.fn(async () => ({ rows: [], columns: [] })),
  migrateLinkedDbViaTursoReplica: vi.fn(async (_s, statements, ledger, writeOptions) => {
    calls.push("migrate");
    migrateArgs.push({ statements, ledger, writeOptions });
    return { executed: [...statements], skipped: [], pendingPush: true };
  }),
}));

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaSchemaLedger.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureReplicaSchemaMigrationsLedger: vi.fn(async () => undefined),
}));

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaMigrationVerify.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  migrationSatisfiedOnReplica: vi.fn(async () => true),
}));

const primaryApply = vi.fn();
vi.mock("../src/gateway/services/jobs/jobMigrationTursoSync.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  applyAndRecordMigrationOnTursoPrimary: primaryApply,
  openTursoPrimaryClient: vi.fn(() => { throw new Error("single route must not open a primary client"); }),
}));

const SEED = [
  "DELETE FROM provider_order;",
  "INSERT INTO provider_order (field, step_no, provider) VALUES ('email', 1, 'c'), ('email', 2, 'd');",
].join("\n");

let root: string;
const source = () => ({
  id: "db-test", type: "sqlite" as const, dbId: "db-test", alias: "t",
  dbPath: path.join(root, "data.db"), tables: [], linkedAt: new Date().toISOString(),
});

beforeEach(() => {
  calls.length = 0;
  migrateArgs.length = 0;
  pushResult = { ok: true };
  online = true;
  primaryApply.mockReset();
  root = mkdtempSync(path.join(tmpdir(), "single-route-"));
  mkdirSync(path.join(root, "migrations"));
  writeFileSync(path.join(root, "migrations", "0006_seed.sql"), SEED);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function apply() {
  const { applyRegistryMigrationSingleRoute } = await import(
    "../src/gateway/services/tursoReplica/tursoReplicaMigrationDualApply.js"
  );
  return applyRegistryMigrationSingleRoute(source(), root, "0006_seed.sql");
}

describe("registry migration single route", () => {
  it("applies once on the replica, then pushes — never re-runs the SQL on the primary", async () => {
    const result = await apply();
    expect(calls).toEqual(["pull", "migrate", "push"]);
    expect(primaryApply).not.toHaveBeenCalled();
    expect(result).toMatchObject({ applied: true, pushed: true, cloudApplied: true, paired: true, pushError: null });
  });

  it("writes both ledger rows in the migration's own transaction", async () => {
    await apply();
    const ledgerSql = migrateArgs[0].ledger.map((s) => s.sql).join("\n");
    expect(ledgerSql).toMatch(/INSERT OR IGNORE INTO schema_migrations/);
    expect(ledgerSql).toMatch(/INSERT OR IGNORE INTO "_papr_schema_migrations"/);
    for (const row of migrateArgs[0].ledger.filter((s) => s.params)) {
      expect(row.params).toEqual(["0006_seed"]);
    }
  });

  it("holds the write's own push so the explicit push runs the migration conflict check", async () => {
    await apply();
    expect(migrateArgs[0].writeOptions).toEqual({ pushAfterWrite: false });
  });

  it("offline: applies locally and leaves the change for the reconnect push", async () => {
    online = false;
    const result = await apply();
    expect(calls).toEqual(["migrate"]);
    expect(result).toMatchObject({ applied: true, pushed: false, cloudApplied: false, paired: false });
  });

  it("reports a refused push (e.g. cloud ahead) instead of claiming the cloud has it", async () => {
    pushResult = { ok: false, error: "MIGRATION_CONFLICT: Cloud schema is ahead" };
    const result = await apply();
    expect(result).toMatchObject({ pushed: false, cloudApplied: false, paired: false });
    expect(result.pushError).toMatch(/MIGRATION_CONFLICT/);
    expect(primaryApply).not.toHaveBeenCalled();
  });
});
