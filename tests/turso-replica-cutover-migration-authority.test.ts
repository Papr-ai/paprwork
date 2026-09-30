import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isRemoteAheadSchemaDrift,
  needsLocalSchemaPushBeforeCutover,
  restoreMigrationLedgerFromBackup,
} from "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverMigrationAuthority.js";
import type { CutoverClassification } from "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverTypes.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

function classification(
  overrides: Partial<CutoverClassification["snapshot"]> & {
    bucket?: CutoverClassification["bucket"];
  },
): CutoverClassification {
  return {
    dbId: "db-test",
    bucket: overrides.bucket ?? "pull_remote",
    reason: "test",
    snapshot: {
      dbExists: true,
      localTableCount: 2,
      remoteTableCount: 2,
      schemaDrift: false,
      legacyArtifactTables: [],
      remoteCheckFailed: false,
      dirty: false,
      quarantined: false,
      localMigrationIds: [],
      remoteMigrationIds: [],
      migrationConflict: false,
      ...overrides,
    },
  };
}

describe("tursoReplicaCutoverMigrationAuthority", () => {
  it("needs schema push when local ledger is ahead of Turso", () => {
    const result = needsLocalSchemaPushBeforeCutover(
      classification({
        localMigrationIds: ["0001_baseline", "0007_repair"],
        remoteMigrationIds: ["0001_baseline"],
      }),
    );
    expect(result).toBe(true);
  });

  it("needs schema push on schema drift with local data", () => {
    const result = needsLocalSchemaPushBeforeCutover(
      classification({
        schemaDrift: true,
        localMigrationIds: ["0001_baseline", "0003_person"],
        remoteMigrationIds: ["0001_baseline", "0003_person"],
      }),
    );
    expect(result).toBe(true);
  });

  it("skips schema push when remote is empty", () => {
    const result = needsLocalSchemaPushBeforeCutover(
      classification({
        bucket: "seed_local",
        remoteTableCount: 0,
        localMigrationIds: ["0001_baseline", "0007_repair"],
      }),
    );
    expect(result).toBe(false);
  });

  it("detects remote-ahead schema drift for blocking", () => {
    expect(
      isRemoteAheadSchemaDrift(
        classification({
          schemaDrift: true,
          localMigrationIds: ["0001_baseline"],
          remoteMigrationIds: ["0001_baseline", "0008_cloud"],
        }).snapshot,
      ),
    ).toBe(true);
  });

  it("does not treat local-ahead drift as remote-ahead", () => {
    expect(
      isRemoteAheadSchemaDrift(
        classification({
          schemaDrift: true,
          localMigrationIds: ["0001_baseline", "0007_repair"],
          remoteMigrationIds: ["0001_baseline"],
        }).snapshot,
      ),
    ).toBe(false);
  });

  it.skipIf(!canUseBetterSqlite)(
    "restores schema_migrations rows from pre-cutover backup",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-cutover-ledger-"));
      const dbPath = path.join(dir, "data.db");
      const backupPath = `${dbPath}.pre-replica.bak`;

      const backup = new Database(backupPath);
      backup.exec(`
        CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations (id, applied_at) VALUES ('0002_drop_fk', datetime('now'));
        INSERT INTO schema_migrations (id, applied_at) VALUES ('0003_person', datetime('now'));
      `);
      backup.close();

      const current = new Database(dbPath);
      current.exec(`
        CREATE TABLE contacts (id INTEGER PRIMARY KEY);
        CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_baseline', datetime('now'));
      `);
      current.close();

      const restored = restoreMigrationLedgerFromBackup(dbPath, backupPath);
      expect(restored.sort()).toEqual(["0002_drop_fk", "0003_person"]);

      const after = new Database(dbPath, { readonly: true });
      const ids = after
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(ids.map((row) => row.id)).toEqual([
        "0001_baseline",
        "0002_drop_fk",
        "0003_person",
      ]);
      after.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );
});
