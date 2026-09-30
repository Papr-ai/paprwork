import { describe, expect, it, vi } from "vitest";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";

describe("migrationSatisfiedOnReplica ledger markers", () => {
  it("treats 0001_baseline as satisfied without querying the replica", async () => {
    const verifyMigrationOnReplica = vi.fn(async () => ({
      satisfied: false,
      unverifiable: [],
    }));

    vi.doMock(
      "../src/gateway/services/jobs/jobMigrationLedgerSync.js",
      () => ({
        verifyMigrationOnRemote: verifyMigrationOnReplica,
      }),
    );

    const { migrationSatisfiedOnReplica } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaMigrationVerify.js"
    );

    const source: AppDataSource = {
      id: "db-home",
      type: "sqlite",
      dbId: "db-home",
      alias: "home-briefs",
      dbPath: "/tmp/data/databases/home-briefs/data.db",
      tables: [],
      linkedAt: new Date().toISOString(),
    };

    await expect(
      migrationSatisfiedOnReplica(source, "/tmp/migrations-root", "0001_baseline"),
    ).resolves.toBe(true);
    await expect(
      migrationSatisfiedOnReplica(
        source,
        "/tmp/migrations-root",
        "0001_baseline.sql",
      ),
    ).resolves.toBe(true);
    expect(verifyMigrationOnReplica).not.toHaveBeenCalled();

    vi.resetModules();
  });

  it("still verifies executable migrations on the replica handle", async () => {
    const verifyMigrationOnReplica = vi.fn(async () => ({
      satisfied: true,
      unverifiable: [],
    }));

    vi.doMock(
      "../src/gateway/services/jobs/jobMigrationLedgerSync.js",
      () => ({
        verifyMigrationOnRemote: verifyMigrationOnReplica,
      }),
    );

    const { migrationSatisfiedOnReplica } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaMigrationVerify.js"
    );

    const source: AppDataSource = {
      id: "db-home",
      type: "sqlite",
      dbId: "db-home",
      alias: "home-briefs",
      dbPath: "/tmp/data/databases/home-briefs/data.db",
      tables: [],
      linkedAt: new Date().toISOString(),
    };

    await expect(
      migrationSatisfiedOnReplica(
        source,
        "/tmp/migrations-root",
        "0002_brief_reviews",
      ),
    ).resolves.toBe(true);
    expect(verifyMigrationOnReplica).toHaveBeenCalledOnce();

    vi.resetModules();
  });
});
