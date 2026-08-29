import { afterEach, describe, expect, it, vi } from "vitest";

describe("tursoReplicaEnabled", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("defaults rollout mode to off", async () => {
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.tursoReplicaRolloutMode()).toBe("off");
    expect(mod.isTursoReplicaSyncFeatureEnabled()).toBe(false);
  });

  it("force mode enables replica for all linked dbs when cloud on", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.tursoReplicaRolloutMode()).toBe("force");
    expect(
      mod.shouldUseTursoReplicaForDb({ syncMode: "legacy" }),
    ).toBe(true);
  });

  it("replica-records mode enables replica only for syncMode=replica", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(
      mod.shouldUseTursoReplicaForDb({ syncMode: "replica" }),
    ).toBe(true);
    expect(
      mod.shouldUseTursoReplicaForDb({ syncMode: "legacy" }),
    ).toBe(false);
    // Uncutover legacy apps still need workspace-log sync during rollout.
    expect(mod.isLegacyWorkspaceRowSyncEnabled()).toBe(true);
  });

  it("startup batch cutover is off unless PAPR_TURSO_REPLICA_CUTOVER_ON_STARTUP=1", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";
    delete process.env.PAPR_TURSO_REPLICA_CUTOVER_ON_STARTUP;
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.shouldRunReplicaCutoverOnStartup()).toBe(false);

    process.env.PAPR_TURSO_REPLICA_CUTOVER_ON_STARTUP = "1";
    vi.resetModules();
    const mod2 = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod2.shouldRunReplicaCutoverOnStartup()).toBe(true);
  });

  it("replica-records respects default cloud sync when CLOUD_SYNC_ENABLED unset", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    delete process.env.CLOUD_SYNC_ENABLED;
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(
      mod.shouldUseTursoReplicaForDb({ syncMode: "replica" }),
    ).toBe(true);
  });

  it("never routes replica when cloud sync disabled", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "false";
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(
      mod.shouldUseTursoReplicaForDb({ syncMode: "replica" }),
    ).toBe(false);
  });

  it("defaults new registry DBs to replica when rollout is replica-records", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.defaultSyncModeForNewRegistryDb()).toBe("replica");
    expect(mod.shouldDeferRegistrySqliteFileForReplica()).toBe(true);
  });

  it("defaults new registry DBs to replica when rollout is force", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.defaultSyncModeForNewRegistryDb()).toBe("replica");
  });

  it("does not defer sqlite file when rollout is off", async () => {
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    process.env.CLOUD_SYNC_ENABLED = "true";
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.defaultSyncModeForNewRegistryDb()).toBeUndefined();
    expect(mod.shouldDeferRegistrySqliteFileForReplica()).toBe(false);
  });
});
