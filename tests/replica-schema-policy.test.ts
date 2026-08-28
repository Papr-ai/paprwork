import { afterEach, describe, expect, it, vi } from "vitest";

describe("replicaSchemaPolicy", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  async function loadPolicy() {
    return import("../src/gateway/services/tursoReplica/replicaSchemaPolicy.js");
  }

  function enablePlanAEnv(): void {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";
  }

  it("isPlanACloudDbAuthority is true when cloud sync and replica rollout are on", async () => {
    enablePlanAEnv();
    const { isPlanACloudDbAuthority } = await loadPolicy();
    expect(isPlanACloudDbAuthority()).toBe(true);
  });

  it("assertPaprDbExecAllowed rejects DDL under Plan A", async () => {
    enablePlanAEnv();
    const { assertPaprDbExecAllowed, SCHEMA_VIA_MIGRATION_MSG } = await loadPolicy();
    expect(() => assertPaprDbExecAllowed("ALTER TABLE t ADD COLUMN x TEXT")).toThrow(
      SCHEMA_VIA_MIGRATION_MSG,
    );
    expect(() => assertPaprDbExecAllowed("INSERT INTO t VALUES (1)")).not.toThrow();
  });

  it("assertPaprDbMigrationApplyAllowed allows offline provisional apply", async () => {
    enablePlanAEnv();
    vi.doMock("../src/gateway/utils/tursoReplicaEnabled.js", () => ({
      isTursoReplicaOnline: () => false,
      isTursoReplicaSyncFeatureEnabled: () => true,
    }));
    const { assertPaprDbMigrationApplyAllowed } = await loadPolicy();
    expect(() => assertPaprDbMigrationApplyAllowed()).not.toThrow();
  });

  it("assertReplicaDdlAllowed requires online for mini-app DDL under Plan A", async () => {
    enablePlanAEnv();
    vi.doMock("../src/gateway/utils/tursoReplicaEnabled.js", () => ({
      isTursoReplicaOnline: () => false,
      isTursoReplicaSyncFeatureEnabled: () => true,
    }));
    const { assertReplicaDdlAllowed, SCHEMA_REQUIRES_ONLINE_MSG } = await loadPolicy();
    expect(() => assertReplicaDdlAllowed("CREATE TABLE foo (id INTEGER)")).toThrow(
      SCHEMA_REQUIRES_ONLINE_MSG,
    );
    expect(() => assertReplicaDdlAllowed("SELECT 1")).not.toThrow();
  });
});
