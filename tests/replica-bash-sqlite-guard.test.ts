import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  detectReplicaRegistrySqliteBlock,
  isRegistryDatabasePath,
  isReplicaManagedDbPathFromRegistry,
  resetReplicaRegistryCacheForTests,
} from "../src/core/utils/replicaBashSqliteGuard.js";

const PLAN_A_ENV = {
  PAPR_TURSO_REPLICA_SYNC: "replica-records",
  CLOUD_SYNC_ENABLED: "true",
} as const;

describe("replicaBashSqliteGuard", () => {
  it("detects registry database paths", () => {
    expect(
      isRegistryDatabasePath("/Users/me/Papr/data/databases/replica-v3/data.db"),
    ).toBe(true);
    expect(isRegistryDatabasePath("/Users/me/Papr/Jobs/job-1/data/data.db")).toBe(
      false,
    );
  });

  it("blocks sqlite3 INSERT against registry DB under Plan A", () => {
    const dbPath = "/Users/me/Papr/data/databases/replica-v3/data.db";
    const block = detectReplicaRegistrySqliteBlock(
      `sqlite3 "${dbPath}" "INSERT INTO t VALUES (1)"`,
      { env: { ...PLAN_A_ENV } },
    );
    expect(block?.message).toMatch(/papr_db_apply_migration/);
  });

  it("allows sqlite3 reads on job scratch DB without registry entry", () => {
    const block = detectReplicaRegistrySqliteBlock(
      `sqlite3 "/Users/me/Papr/Jobs/job-1/data/data.db" "SELECT 1"`,
      { env: { ...PLAN_A_ENV } },
    );
    expect(block).toBeNull();
  });

  it("blocks sqlite3 writes on job DB when registry marks syncMode=replica", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-replica-guard-"));
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const jobDbPath = path.join(tmpRoot, "Jobs", "job-replica", "data", "data.db");
    fs.mkdirSync(path.dirname(jobDbPath), { recursive: true });
    fs.writeFileSync(jobDbPath, "");
    fs.writeFileSync(
      path.join(dataDir, "databases.json"),
      JSON.stringify({
        version: 1,
        databases: {
          "db-job-replica": {
            dbId: "db-job-replica",
            localPath: jobDbPath,
            tursoShortName: "d-job-rep",
            isolation: "shared",
            status: "active",
            syncMode: "replica",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const prevHome = process.env.PAPR_HOME;
    process.env.PAPR_HOME = tmpRoot;
    resetReplicaRegistryCacheForTests();
    const env = { ...PLAN_A_ENV, PAPR_HOME: tmpRoot };

    try {
      expect(isReplicaManagedDbPathFromRegistry(jobDbPath, env)).toBe(true);
      const block = detectReplicaRegistrySqliteBlock(
        `sqlite3 "${jobDbPath}" "INSERT INTO t VALUES (1)"`,
        { env },
      );
      expect(block?.message).toMatch(/papr_db_exec/);
    } finally {
      process.env.PAPR_HOME = prevHome;
      resetReplicaRegistryCacheForTests();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("blocks sqlite3 input redirect against registry DB under Plan A", () => {
    const dbPath = "/Users/me/Papr/data/databases/replica-v3/data.db";
    const block = detectReplicaRegistrySqliteBlock(
      `sqlite3 "${dbPath}" < seed.sql`,
      { env: { ...PLAN_A_ENV } },
    );
    expect(block?.message).toMatch(/papr_db_apply_migration/);
  });

  it("blocks registry sqlite when cloud sync defaults on (env unset)", () => {
    const dbPath = "/Users/me/Papr/data/databases/replica-v3/data.db";
    const block = detectReplicaRegistrySqliteBlock(
      `sqlite3 "${dbPath}" "INSERT INTO t VALUES (1)"`,
      {
        env: {
          PAPR_TURSO_REPLICA_SYNC: "replica-records",
        },
      },
    );
    expect(block?.message).toMatch(/papr_db_apply_migration/);
  });

  it("allows registry sqlite when Plan A env is off", () => {
    const dbPath = "/Users/me/Papr/data/databases/replica-v3/data.db";
    const block = detectReplicaRegistrySqliteBlock(
      `sqlite3 "${dbPath}" "INSERT INTO t VALUES (1)"`,
      {
        env: {
          PAPR_TURSO_REPLICA_SYNC: "off",
          CLOUD_SYNC_ENABLED: "false",
        },
      },
    );
    expect(block).toBeNull();
  });
});
