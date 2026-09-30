import { describe, expect, it } from "vitest";
import { migrationRerunSafety } from "../src/gateway/services/jobs/migrationSqlHelpers.js";
import {
  decideReplicaMigration,
  replicaMigrationNeedsVerification,
} from "../src/gateway/services/tursoReplica/tursoReplicaMigrationRerunPolicy.js";

/**
 * The shape of the migration whose re-runs emptied a telemetry database on
 * 2026-09-24: add a run dimension by rebuilding a table with copy-and-swap.
 */
const REBUILD = `
-- 0002_multi_run, rebuild version
CREATE TABLE IF NOT EXISTS runs (run TEXT PRIMARY KEY, label TEXT);
INSERT OR IGNORE INTO runs (run, label) VALUES ('0.6b', '0.6B');
ALTER TABLE step ADD COLUMN run TEXT NOT NULL DEFAULT '0.6b';
CREATE TABLE health_v2 (ts TEXT NOT NULL, run TEXT NOT NULL DEFAULT '0.6b', status TEXT, PRIMARY KEY (run, ts));
INSERT INTO health_v2 (ts, run, status) SELECT ts, '0.6b', status FROM health;
DROP TABLE health;
ALTER TABLE health_v2 RENAME TO health;
CREATE INDEX IF NOT EXISTS idx_health_run_ts ON health (run, ts);
`;

describe("migrationRerunSafety", () => {
  it("flags every statement of a copy-and-swap rebuild that loses rows on re-run", () => {
    const { safe, hazards } = migrationRerunSafety(REBUILD);
    expect(safe).toBe(false);
    expect(hazards).toContain("DROP TABLE health");
    expect(hazards).toContain("ALTER TABLE health_v2 RENAME TO health");
    expect(hazards.some((h) => h.startsWith("INSERT INTO health_v2"))).toBe(true);
    // The INSERT OR IGNORE seed, the ADD COLUMN and the CREATEs are fine.
    expect(hazards).toHaveLength(3);
  });

  it("passes additive and idempotent migrations", () => {
    const additive = `
      CREATE TABLE IF NOT EXISTS run_health (ts TEXT NOT NULL, run TEXT NOT NULL, PRIMARY KEY (run, ts));
      CREATE TABLE step (run_id TEXT, step INTEGER);
      ALTER TABLE step ADD COLUMN run TEXT NOT NULL DEFAULT '0.6b';
      CREATE INDEX IF NOT EXISTS idx_step_run ON step (run, step);
      CREATE UNIQUE INDEX idx_u ON step (run_id, step);
      DROP INDEX IF EXISTS idx_old;
      INSERT OR IGNORE INTO runs (run) VALUES ('4b');
      INSERT INTO runs (run) VALUES ('0.6b') ON CONFLICT (run) DO NOTHING;
      CREATE VIEW IF NOT EXISTS v AS SELECT * FROM step;
      DROP VIEW IF EXISTS v_old;
      ALTER TABLE step RENAME COLUMN loss TO nce_loss;
      PRAGMA foreign_keys = ON;
    `;
    expect(migrationRerunSafety(additive)).toEqual({ safe: true, hazards: [] });
  });

  it.each([
    ["DROP TABLE IF EXISTS gpu_v2", "DROP TABLE gpu_v2"],
    ['ALTER TABLE "old" RENAME TO "new"', "ALTER TABLE old RENAME TO new"],
    ["ALTER TABLE step DROP COLUMN loss", "ALTER TABLE step DROP COLUMN loss"],
    ["DELETE FROM run_gpu WHERE ts < '2026-01-01'", "DELETE FROM run_gpu WHERE ts < '2026-01-01'"],
    ["UPDATE runs SET status = 'done'", "UPDATE runs SET status = 'done'"],
    ["INSERT OR REPLACE INTO runs (run) VALUES ('4b')", "INSERT OR REPLACE INTO runs (run) VALUES ('4b')"],
    ["REPLACE INTO runs (run) VALUES ('4b')", "REPLACE INTO runs (run) VALUES ('4b')"],
    ["INSERT INTO step SELECT * FROM step_old", "INSERT INTO step SELECT * FROM step_old"],
  ])("flags %s", (statement, hazard) => {
    expect(migrationRerunSafety(statement)).toEqual({ safe: false, hazards: [hazard] });
  });

  it("flags an upsert that overwrites and a data change behind WITH", () => {
    const upsert =
      "INSERT INTO runs (run, status) VALUES ('4b', 'x') ON CONFLICT (run) DO UPDATE SET status = excluded.status";
    expect(migrationRerunSafety(upsert).safe).toBe(false);
    const cte =
      "WITH old AS (SELECT ts FROM run_gpu) DELETE FROM run_gpu WHERE ts IN (SELECT ts FROM old)";
    expect(migrationRerunSafety(cte).safe).toBe(false);
  });

  it("ignores keywords inside comments and string literals", () => {
    const sql = `
      -- DROP TABLE health; DELETE FROM gpu;
      /* UPDATE runs SET x = 1; */
      INSERT OR IGNORE INTO notes (body) VALUES ('DROP TABLE y; DELETE FROM z');
    `;
    expect(migrationRerunSafety(sql)).toEqual({ safe: true, hazards: [] });
    // A literal cannot fake the DO NOTHING clause either.
    expect(
      migrationRerunSafety("INSERT INTO notes (body) VALUES ('ON CONFLICT DO NOTHING')").safe,
    ).toBe(false);
  });
});

describe("decideReplicaMigration", () => {
  it("runs a pending migration on a readable ledger without verifying, destructive or not", () => {
    expect(replicaMigrationNeedsVerification(false, true)).toBe(false);
    for (const rerunSafe of [true, false]) {
      expect(
        decideReplicaMigration({ recorded: false, ledgerReadable: true, satisfied: null, rerunSafe }),
      ).toEqual({ action: "apply", reason: "pending" });
    }
  });

  it("skips a recorded migration whose schema verifies", () => {
    expect(replicaMigrationNeedsVerification(true, true)).toBe(true);
    expect(
      decideReplicaMigration({ recorded: true, ledgerReadable: true, satisfied: true, rerunSafe: false }),
    ).toEqual({ action: "skip", reason: "applied" });
  });

  it("still repairs drift by re-applying a recorded ADDITIVE migration", () => {
    expect(
      decideReplicaMigration({ recorded: true, ledgerReadable: true, satisfied: false, rerunSafe: true }),
    ).toEqual({ action: "apply", reason: "reapply_additive" });
  });

  it("refuses to re-run a recorded DESTRUCTIVE migration it cannot verify", () => {
    expect(
      decideReplicaMigration({ recorded: true, ledgerReadable: true, satisfied: false, rerunSafe: false }),
    ).toEqual({ action: "refuse", reason: "recorded_unverified" });
  });

  it("never treats an unreadable ledger as an empty one", () => {
    expect(replicaMigrationNeedsVerification(false, false)).toBe(true);
    expect(
      decideReplicaMigration({ recorded: false, ledgerReadable: false, satisfied: true, rerunSafe: false }),
    ).toEqual({ action: "skip", reason: "schema_present" });
    expect(
      decideReplicaMigration({ recorded: false, ledgerReadable: false, satisfied: false, rerunSafe: true }),
    ).toEqual({ action: "apply", reason: "unknown_ledger_additive" });
    expect(
      decideReplicaMigration({ recorded: false, ledgerReadable: false, satisfied: false, rerunSafe: false }),
    ).toEqual({ action: "refuse", reason: "unknown_ledger" });
  });
});
