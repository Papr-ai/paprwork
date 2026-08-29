import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseRecord } from "../src/gateway/services/DatabaseRegistryService.js";
import { detectMigrationPushConflict } from "../src/gateway/services/tursoReplica/tursoReplicaMigrationConflict.js";

function baseRecord(overrides: Partial<DatabaseRecord> = {}): DatabaseRecord {
  const now = new Date().toISOString();
  return {
    dbId: "db-test",
    localPath: "/tmp/data/databases/test/data.db",
    tursoShortName: "d-test0001",
    isolation: "shared",
    status: "active",
    syncMode: "legacy",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("tursoReplicaCutoverClassify", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    delete process.env.CLOUD_SYNC_ENABLED;
  });

  it("skips databases already on syncMode=replica", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverSnapshot.js",
      () => ({
        snapshotLegacyRecordForCutover: vi.fn(async () => ({
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
        })),
      }),
    );

    const { classifyRecordForReplicaCutover } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js"
    );

    const result = await classifyRecordForReplicaCutover(
      baseRecord({ syncMode: "replica", cutoverAt: new Date().toISOString() }),
    );

    expect(result.bucket).toBe("skip");
  });

  it("classifies remote-empty + local rows as seed_local", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverSnapshot.js",
      () => ({
        snapshotLegacyRecordForCutover: vi.fn(async () => ({
          dbExists: true,
          localTableCount: 3,
          remoteTableCount: 0,
          schemaDrift: false,
          legacyArtifactTables: [],
          remoteCheckFailed: false,
          dirty: true,
          quarantined: false,
          localMigrationIds: ["0001_baseline"],
          remoteMigrationIds: [],
          migrationConflict: false,
        })),
      }),
    );

    const { classifyRecordForReplicaCutover } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js"
    );

    const result = await classifyRecordForReplicaCutover(baseRecord());
    expect(result.bucket).toBe("seed_local");
  });

  it("classifies Turso-with-data path as pull_remote", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverSnapshot.js",
      () => ({
        snapshotLegacyRecordForCutover: vi.fn(async () => ({
          dbExists: true,
          localTableCount: 2,
          remoteTableCount: 4,
          schemaDrift: false,
          legacyArtifactTables: [],
          remoteCheckFailed: false,
          dirty: false,
          quarantined: false,
          localMigrationIds: ["0001_baseline"],
          remoteMigrationIds: ["0001_baseline"],
          migrationConflict: false,
        })),
      }),
    );

    const { classifyRecordForReplicaCutover } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js"
    );

    const result = await classifyRecordForReplicaCutover(baseRecord());
    expect(result.bucket).toBe("pull_remote");
  });

  it("blocks schema drift when both sides have tables", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverSnapshot.js",
      () => ({
        snapshotLegacyRecordForCutover: vi.fn(async () => ({
          dbExists: true,
          localTableCount: 2,
          remoteTableCount: 2,
          schemaDrift: true,
          legacyArtifactTables: [],
          remoteCheckFailed: false,
          dirty: false,
          quarantined: false,
          localMigrationIds: [],
          remoteMigrationIds: [],
          migrationConflict: false,
        })),
      }),
    );

    const { classifyRecordForReplicaCutover } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js"
    );

    const result = await classifyRecordForReplicaCutover(baseRecord());
    expect(result.bucket).toBe("blocked");
  });

  it("does not block cutover when schema drift is legacy CDC artifacts only", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverSnapshot.js",
      () => ({
        snapshotLegacyRecordForCutover: vi.fn(async () => ({
          dbExists: true,
          localTableCount: 1,
          remoteTableCount: 1,
          schemaDrift: true,
          legacyArtifactTables: ["turso_cdc", "turso_cdc_version"],
          remoteCheckFailed: false,
          dirty: false,
          quarantined: false,
          localMigrationIds: [],
          remoteMigrationIds: [],
          migrationConflict: false,
        })),
      }),
    );

    const { classifyRecordForReplicaCutover } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js"
    );

    const result = await classifyRecordForReplicaCutover(baseRecord());
    expect(result.bucket).toBe("pull_remote");
  });

  it("blocks migration ledger conflicts (bucket D)", async () => {
    const conflict = detectMigrationPushConflict(
      ["0006_local", "0007_offline"],
      ["0001_baseline", "0008_cloud"],
    );
    expect(conflict).not.toBeNull();

    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverSnapshot.js",
      () => ({
        snapshotLegacyRecordForCutover: vi.fn(async () => ({
          dbExists: true,
          localTableCount: 2,
          remoteTableCount: 2,
          schemaDrift: false,
          legacyArtifactTables: [],
          remoteCheckFailed: false,
          dirty: true,
          quarantined: false,
          localMigrationIds: ["0006_local", "0007_offline"],
          remoteMigrationIds: ["0001_baseline", "0008_cloud"],
          migrationConflict: true,
          migrationConflictReason: conflict?.message,
        })),
      }),
    );

    const { classifyRecordForReplicaCutover } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js"
    );

    const result = await classifyRecordForReplicaCutover(baseRecord());
    expect(result.bucket).toBe("blocked");
    expect(result.reason).toContain("MIGRATION_CONFLICT");
  });
});

describe("shouldRunReplicaCutover", () => {
  afterEach(() => {
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    delete process.env.CLOUD_SYNC_ENABLED;
  });

  it("is active for replica-records rollout with cloud on", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";
    const { shouldRunReplicaCutover } = await import(
      "../src/gateway/utils/tursoReplicaEnabled.js"
    );
    expect(shouldRunReplicaCutover()).toBe(true);
  });

  it("is inactive when rollout env is off", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    const { shouldRunReplicaCutover } = await import(
      "../src/gateway/utils/tursoReplicaEnabled.js"
    );
    expect(shouldRunReplicaCutover()).toBe(false);
  });
});

describe("preReplicaBackupPath", () => {
  it("uses .pre-replica.bak suffix", async () => {
    const { preReplicaBackupPath } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverBackup.js"
    );
    expect(preReplicaBackupPath("/tmp/app/data.db")).toBe(
      "/tmp/app/data.db.pre-replica.bak",
    );
  });
});

describe("tursoReplicaCutoverOrchestrator", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    delete process.env.CLOUD_SYNC_ENABLED;
    delete process.env.PAPR_TURSO_REPLICA_SYNC_ALLOW_PRODUCTION;
  });

  it("marks syncMode=replica only after provision succeeds", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const callOrder: string[] = [];
    const markCutover = vi.fn(async () => {
      callOrder.push("mark");
    });
    const attachInPlace = vi.fn(async () => {
      callOrder.push("attach");
    });
    const provisionCutover = vi.fn(async () => {
      callOrder.push("provision");
    });
    const restoreBackup = vi.fn(async () => true);
    const updatePushState = vi.fn(async () => {});
    const closeReplica = vi.fn(async () => {});

    vi.doMock(
      "../src/gateway/services/DatabaseRegistryService.js",
      () => ({
        getDatabaseRegistryService: () => ({
          getById: () => baseRecord(),
          markSyncModeReplicaCutover: markCutover,
          updateReplicaPushState: updatePushState,
        }),
        initializeDatabaseRegistry: vi.fn(async () => {}),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js",
      () => ({
        classifyRecordForReplicaCutover: vi.fn(async () => ({
          dbId: "db-test",
          bucket: "seed_local",
          reason: "[seed_local] test",
          snapshot: {
            dbExists: true,
            localTableCount: 1,
            remoteTableCount: 0,
            schemaDrift: false,
          legacyArtifactTables: [],
            remoteCheckFailed: false,
            dirty: true,
            quarantined: false,
            localMigrationIds: [],
            remoteMigrationIds: [],
            migrationConflict: false,
          },
        })),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverBackup.js",
      () => ({
        backupLocalDbPreReplica: vi.fn(async () => "/tmp/data.db.pre-replica.bak"),
        restoreLocalDbFromPreReplicaBackup: restoreBackup,
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/tursoReplicaProvision.js",
      () => ({
        attachTursoReplicaInPlaceForCutover: attachInPlace,
        provisionTursoReplicaForCutover: provisionCutover,
        pushLocalLegacyFileToTursoPrimary: vi.fn(async () => {}),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/TursoReplicaService.js",
      () => ({
        getTursoReplicaService: () => ({ close: closeReplica }),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverVerify.js",
      () => ({
        verifyReplicaCutoverHealth: vi.fn(async () => ({ ok: true })),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoSyncState.js",
      () => ({
        clearLegacyTursoSyncStateForDbPath: vi.fn(() => 0),
      }),
    );

    const { runCutoverForRecord } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js"
    );

    const result = await runCutoverForRecord(baseRecord(), {
      allowWithoutProductionAck: true,
    });

    expect(result.ok).toBe(true);
    expect(callOrder).toEqual(["attach", "mark"]);
    expect(attachInPlace).toHaveBeenCalledTimes(1);
    expect(provisionCutover).not.toHaveBeenCalled();
    expect(markCutover).toHaveBeenCalledTimes(1);
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it("pull_remote uses in-place attach without legacy push", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const attachInPlace = vi.fn(async () => {});
    const legacyPush = vi.fn(async () => {});
    const markCutover = vi.fn(async () => {});

    vi.doMock("../src/gateway/services/legacyCdcArtifacts.js", () => ({
      stripLegacySyncPathArtifacts: vi.fn(() => []),
    }));
    vi.doMock("fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs")>();
      return {
        ...actual,
        existsSync: vi.fn(() => true),
      };
    });
    vi.doMock(
      "../src/gateway/services/DatabaseRegistryService.js",
      () => ({
        getDatabaseRegistryService: () => ({
          getById: () => baseRecord(),
          markSyncModeReplicaCutover: markCutover,
          updateReplicaPushState: vi.fn(async () => {}),
        }),
        initializeDatabaseRegistry: vi.fn(async () => {}),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js",
      () => ({
        classifyRecordForReplicaCutover: vi.fn(async () => ({
          dbId: "db-test",
          bucket: "pull_remote",
          reason: "[pull_remote] Turso has data",
          snapshot: {
            dbExists: true,
            localTableCount: 18,
            remoteTableCount: 18,
            schemaDrift: false,
            legacyArtifactTables: ["_papr_oplog"],
            remoteCheckFailed: false,
            dirty: true,
            quarantined: false,
            localMigrationIds: [],
            remoteMigrationIds: [],
            migrationConflict: false,
          },
        })),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverBackup.js",
      () => ({
        backupLocalDbPreReplica: vi.fn(async () => "/tmp/data.db.pre-replica.bak"),
        restoreLocalDbFromPreReplicaBackup: vi.fn(async () => true),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/tursoReplicaProvision.js",
      () => ({
        attachTursoReplicaInPlaceForCutover: attachInPlace,
        provisionTursoReplicaForCutover: vi.fn(async () => {}),
        pushLocalLegacyFileToTursoPrimary: legacyPush,
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/TursoReplicaService.js",
      () => ({
        getTursoReplicaService: () => ({ close: vi.fn(async () => {}) }),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverVerify.js",
      () => ({
        verifyReplicaCutoverHealth: vi.fn(async () => ({ ok: true })),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoSyncState.js",
      () => ({
        clearLegacyTursoSyncStateForDbPath: vi.fn(() => 0),
      }),
    );

    const { runCutoverForRecord } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js"
    );

    const result = await runCutoverForRecord(baseRecord(), {
      allowWithoutProductionAck: true,
    });

    expect(result.ok).toBe(true);
    expect(legacyPush).not.toHaveBeenCalled();
    expect(attachInPlace).toHaveBeenCalledTimes(1);
    expect(markCutover).toHaveBeenCalledTimes(1);
  });

  it("both-empty seed_local uses wipe provision path", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const attachInPlace = vi.fn(async () => {});
    const provisionCutover = vi.fn(async () => {});

    vi.doMock("../src/gateway/services/legacyCdcArtifacts.js", () => ({
      stripLegacySyncPathArtifacts: vi.fn(() => []),
    }));

    vi.doMock(
      "../src/gateway/services/DatabaseRegistryService.js",
      () => ({
        getDatabaseRegistryService: () => ({
          getById: () => baseRecord(),
          markSyncModeReplicaCutover: vi.fn(async () => {}),
          updateReplicaPushState: vi.fn(async () => {}),
        }),
        initializeDatabaseRegistry: vi.fn(async () => {}),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js",
      () => ({
        classifyRecordForReplicaCutover: vi.fn(async () => ({
          dbId: "db-test",
          bucket: "seed_local",
          reason: "[seed_local] both empty",
          snapshot: {
            dbExists: false,
            localTableCount: 0,
            remoteTableCount: 0,
            schemaDrift: false,
            legacyArtifactTables: [],
            remoteCheckFailed: false,
            dirty: false,
            quarantined: false,
            localMigrationIds: [],
            remoteMigrationIds: [],
            migrationConflict: false,
          },
        })),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverBackup.js",
      () => ({
        backupLocalDbPreReplica: vi.fn(async () => undefined),
        restoreLocalDbFromPreReplicaBackup: vi.fn(async () => true),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/tursoReplicaProvision.js",
      () => ({
        attachTursoReplicaInPlaceForCutover: attachInPlace,
        provisionTursoReplicaForCutover: provisionCutover,
        pushLocalLegacyFileToTursoPrimary: vi.fn(async () => {}),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/TursoReplicaService.js",
      () => ({
        getTursoReplicaService: () => ({ close: vi.fn(async () => {}) }),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverVerify.js",
      () => ({
        verifyReplicaCutoverHealth: vi.fn(async () => ({ ok: true })),
      }),
    );

    const { runCutoverForRecord } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js"
    );

    const result = await runCutoverForRecord(baseRecord(), {
      allowWithoutProductionAck: true,
    });

    expect(result.ok).toBe(true);
    expect(provisionCutover).toHaveBeenCalledTimes(1);
    expect(attachInPlace).not.toHaveBeenCalled();
  });

  it("restores backup and stays legacy when provision fails", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const markCutover = vi.fn(async () => {});
    const provisionCutover = vi.fn(async () => {
      throw new Error("provision failed");
    });
    const restoreBackup = vi.fn(async () => true);
    const updatePushState = vi.fn(async () => {});

    vi.doMock(
      "../src/gateway/services/DatabaseRegistryService.js",
      () => ({
        getDatabaseRegistryService: () => ({
          getById: () => baseRecord({ syncMode: "legacy" }),
          markSyncModeReplicaCutover: markCutover,
          updateReplicaPushState: updatePushState,
        }),
        initializeDatabaseRegistry: vi.fn(async () => {}),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js",
      () => ({
        classifyRecordForReplicaCutover: vi.fn(async () => ({
          dbId: "db-test",
          bucket: "seed_local",
          reason: "[seed_local] test",
          snapshot: {
            dbExists: false,
            localTableCount: 0,
            remoteTableCount: 0,
            schemaDrift: false,
          legacyArtifactTables: [],
            remoteCheckFailed: false,
            dirty: false,
            quarantined: false,
            localMigrationIds: [],
            remoteMigrationIds: [],
            migrationConflict: false,
          },
        })),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverBackup.js",
      () => ({
        backupLocalDbPreReplica: vi.fn(async () => "/tmp/data.db.pre-replica.bak"),
        restoreLocalDbFromPreReplicaBackup: restoreBackup,
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/tursoReplicaProvision.js",
      () => ({
        provisionTursoReplicaForCutover: provisionCutover,
        pushLocalLegacyFileToTursoPrimary: vi.fn(async () => {}),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/TursoReplicaService.js",
      () => ({
        getTursoReplicaService: () => ({ close: vi.fn(async () => {}) }),
      }),
    );

    const { runCutoverForRecord } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js"
    );

    const result = await runCutoverForRecord(baseRecord(), {
      allowWithoutProductionAck: true,
    });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(markCutover).not.toHaveBeenCalled();
    expect(restoreBackup).toHaveBeenCalledTimes(1);
    expect(updatePushState).toHaveBeenCalledWith(
      "db-test",
      expect.objectContaining({ cutoverBlocked: true, cutoverInProgress: false }),
    );
  });

  it("resumes interrupted cutover by restoring backup when syncMode is still legacy", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const updatePushState = vi.fn(async () => {});
    const restoreBackup = vi.fn(async () => true);

    vi.doMock(
      "../src/gateway/services/DatabaseRegistryService.js",
      () => ({
        getDatabaseRegistryService: () => ({
          getById: () =>
            baseRecord({ cutoverInProgress: true, syncMode: "legacy" }),
          listActive: () => [
            baseRecord({ cutoverInProgress: true, syncMode: "legacy" }),
          ],
          markSyncModeReplicaCutover: vi.fn(async () => {}),
          updateReplicaPushState: updatePushState,
        }),
        initializeDatabaseRegistry: vi.fn(async () => {}),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverBackup.js",
      () => ({
        backupLocalDbPreReplica: vi.fn(async () => "/tmp/data.db.pre-replica.bak"),
        restoreLocalDbFromPreReplicaBackup: restoreBackup,
      }),
    );

    const { resumeInterruptedReplicaCutover } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js"
    );

    const result = await resumeInterruptedReplicaCutover(
      baseRecord({ cutoverInProgress: true, syncMode: "legacy" }),
    );

    expect(result.resumed).toBe(true);
    expect(result.action).toBe("restored");
    expect(restoreBackup).toHaveBeenCalledTimes(1);
    expect(updatePushState).toHaveBeenCalledWith(
      "db-test",
      expect.objectContaining({ cutoverInProgress: false }),
    );
  });

  it("clears stale cutoverInProgress when syncMode is already replica", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const updatePushState = vi.fn(async () => {});
    const restoreBackup = vi.fn(async () => true);

    vi.doMock(
      "../src/gateway/services/DatabaseRegistryService.js",
      () => ({
        getDatabaseRegistryService: () => ({
          getById: () =>
            baseRecord({
              cutoverInProgress: true,
              syncMode: "replica",
              cutoverAt: new Date().toISOString(),
            }),
          markSyncModeReplicaCutover: vi.fn(async () => {}),
          updateReplicaPushState: updatePushState,
        }),
        initializeDatabaseRegistry: vi.fn(async () => {}),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverBackup.js",
      () => ({
        backupLocalDbPreReplica: vi.fn(async () => undefined),
        restoreLocalDbFromPreReplicaBackup: restoreBackup,
      }),
    );

    const { resumeInterruptedReplicaCutover } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js"
    );

    const result = await resumeInterruptedReplicaCutover(
      baseRecord({
        cutoverInProgress: true,
        syncMode: "replica",
        cutoverAt: new Date().toISOString(),
      }),
    );

    expect(result.action).toBe("cleared");
    expect(restoreBackup).not.toHaveBeenCalled();
    expect(updatePushState).toHaveBeenCalledWith(
      "db-test",
      expect.objectContaining({ cutoverInProgress: false }),
    );
  });
});

describe("listLinkedLegacyCutoverCandidates", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns only legacy registry DBs linked from app data-sources", async () => {
    const linkedRecord = baseRecord({ dbId: "db-linked" });
    const orphanRecord = baseRecord({
      dbId: "db-orphan",
      localPath: "/tmp/orphan/data.db",
    });

    vi.doMock(
      "../src/gateway/services/DatabaseRegistryService.js",
      () => ({
        getDatabaseRegistryService: () => ({
          listActive: () => [linkedRecord, orphanRecord],
        }),
        initializeDatabaseRegistry: vi.fn(async () => {}),
      }),
    );
    vi.doMock(
      "../src/gateway/services/TursoSyncBridge.js",
      () => ({
        ensureTursoSyncBridge: () => ({
          getAppsRootDir: () => "/tmp/apps",
        }),
      }),
    );
    vi.doMock(
      "../src/gateway/services/tursoLinkedSources.js",
      () => ({
        discoverTursoLinkedSources: vi.fn(async () => [
          {
            appId: "app-1",
            dbId: "db-linked",
            dbPath: linkedRecord.localPath,
            alias: "linked",
            role: "primary",
          },
        ]),
      }),
    );

    const { listLinkedLegacyCutoverCandidates } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverCandidates.js"
    );

    const candidates = await listLinkedLegacyCutoverCandidates();
    expect(candidates.map((record) => record.dbId)).toEqual(["db-linked"]);
  });
});

describe("runReplicaCutoverForAppUpload", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unmock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverCandidates.js",
    );
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    delete process.env.CLOUD_SYNC_ENABLED;
  });

  it("listLegacyCutoverCandidatesForApp scopes to one mini-app", async () => {
    const linkedRecord = baseRecord({ dbId: "db-linked" });
    const otherRecord = baseRecord({
      dbId: "db-other",
      localPath: "/tmp/other/data.db",
    });

    vi.doMock(
      "../src/gateway/services/DatabaseRegistryService.js",
      () => ({
        getDatabaseRegistryService: () => ({
          listActive: () => [linkedRecord, otherRecord],
        }),
        initializeDatabaseRegistry: vi.fn(async () => {}),
      }),
    );
    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
      ensureTursoSyncBridge: () => ({
        getAppsRootDir: () => "/tmp/papr/apps",
      }),
    }));
    vi.doMock(
      "../src/gateway/services/tursoLinkedSources.js",
      () => ({
        discoverTursoLinkedSources: vi.fn(async () => [
          {
            appId: "app-1",
            dbId: "db-linked",
            dbPath: linkedRecord.localPath,
            alias: "linked",
            role: "primary",
          },
          {
            appId: "app-2",
            dbId: "db-other",
            dbPath: otherRecord.localPath,
            alias: "other",
            role: "primary",
          },
        ]),
      }),
    );

    const { listLegacyCutoverCandidatesForApp } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverCandidates.js"
    );

    const appOne = await listLegacyCutoverCandidatesForApp("app-1");
    expect(appOne.map((record) => record.dbId)).toEqual(["db-linked"]);

    const appTwo = await listLegacyCutoverCandidatesForApp("app-2");
    expect(appTwo.map((record) => record.dbId)).toEqual(["db-other"]);
  });

  it("skips startup batch when fromStartup and CUTOVER_ON_STARTUP unset", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";
    delete process.env.PAPR_TURSO_REPLICA_CUTOVER_ON_STARTUP;

    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverCandidates.js",
      () => ({
        listLinkedLegacyCutoverCandidates: vi.fn(async () => [
          baseRecord({ dbId: "db-would-run" }),
        ]),
        listLegacyCutoverCandidatesForApp: vi.fn(async () => []),
      }),
    );

    const { runPendingReplicaCutovers } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js"
    );

    const batch = await runPendingReplicaCutovers({ fromStartup: true });
    expect(batch.results).toEqual([]);
  });
});

describe("formatReplicaCutoverUploadFailure", () => {
  it("surfaces blocked cutover attempts on Upload now", async () => {
    const { formatReplicaCutoverUploadFailure } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js"
    );

    const message = formatReplicaCutoverUploadFailure({
      dryRun: false,
      attempted: 1,
      succeeded: 0,
      blocked: 1,
      skipped: 1,
      results: [
        {
          dbId: "db-9d5b01af",
          dryRun: false,
          classification: {
            dbId: "db-9d5b01af",
            bucket: "blocked",
            reason: "[blocked] Schema drift",
            snapshot: {
              dbExists: true,
              localTableCount: 2,
              remoteTableCount: 1,
              schemaDrift: true,
              legacyArtifactTables: [],
              remoteCheckFailed: false,
              dirty: false,
              quarantined: false,
              localMigrationIds: [],
              remoteMigrationIds: [],
              migrationConflict: false,
            },
          },
          ok: false,
          skipped: true,
          blocked: true,
          error: "[blocked] Schema drift",
        },
      ],
    });

    expect(message).toMatch(/Replica cutover failed/);
    expect(message).toMatch(/db-9d5b01af/);
  });
});
