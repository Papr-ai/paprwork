/**
 * Plan A Phase 3 — orchestrate legacy → replica cutover per registry db.
 */

import * as fs from "fs";
import type { DatabaseRecord } from "../../DatabaseRegistryService.js";
import {
  getDatabaseRegistryService,
  initializeDatabaseRegistry,
} from "../../DatabaseRegistryService.js";
import { getWorkspaceSwitchHealthStatus } from "../../workspaceSwitchService.js";
import {
  shouldRunReplicaCutover,
  shouldRunReplicaCutoverOnStartup,
} from "../../../utils/tursoReplicaEnabled.js";
import { getTursoReplicaService } from "../TursoReplicaService.js";
import {
  provisionTursoReplicaForCutover,
  pushLocalLegacyFileToTursoPrimary,
} from "../tursoReplicaProvision.js";
import { classifyRecordForReplicaCutover } from "./tursoReplicaCutoverClassify.js";
import {
  backupLocalDbPreReplica,
  restoreLocalDbFromPreReplicaBackup,
} from "./tursoReplicaCutoverBackup.js";
import {
  listLegacyCutoverCandidatesForApp,
  listLinkedLegacyCutoverCandidates,
} from "./tursoReplicaCutoverCandidates.js";
import { stripLegacyCdcArtifacts } from "../../legacyCdcArtifacts.js";
import type {
  CutoverBatchResult,
  CutoverClassification,
  CutoverRunResult,
} from "./tursoReplicaCutoverTypes.js";

function isCutoverExecutionAllowed(options?: {
  dryRun?: boolean;
  allowWithoutProductionAck?: boolean;
}): boolean {
  if (options?.dryRun) {
    return true;
  }
  if (options?.allowWithoutProductionAck) {
    return true;
  }
  return process.env.PAPR_TURSO_REPLICA_SYNC_ALLOW_PRODUCTION === "1";
}

async function blockCutover(
  dbId: string,
  reason: string,
): Promise<void> {
  const registry = getDatabaseRegistryService();
  await registry.updateReplicaPushState(dbId, {
    cutoverBlocked: true,
    cutoverBlockReason: reason.slice(0, 500),
    cutoverInProgress: false,
    cutoverStartedAt: null,
  });
}

async function markCutoverInProgress(dbId: string): Promise<void> {
  const registry = getDatabaseRegistryService();
  await registry.updateReplicaPushState(dbId, {
    cutoverInProgress: true,
    cutoverStartedAt: new Date().toISOString(),
    cutoverBlocked: false,
    cutoverBlockReason: null,
  });
}

async function clearCutoverInProgress(dbId: string): Promise<void> {
  const registry = getDatabaseRegistryService();
  await registry.updateReplicaPushState(dbId, {
    cutoverInProgress: false,
    cutoverStartedAt: null,
  });
}

/**
 * Recover from a crash mid-cutover before starting a new attempt.
 * - syncMode=replica + flag set → cutover finished; clear flag only.
 * - syncMode=legacy + flag set → restore from .pre-replica.bak, clear flag, retry.
 */
export async function resumeInterruptedReplicaCutover(
  record: DatabaseRecord,
): Promise<{ resumed: boolean; action: "cleared" | "restored" | "none" }> {
  if (!record.cutoverInProgress) {
    return { resumed: false, action: "none" };
  }

  if (record.syncMode === "replica") {
    await clearCutoverInProgress(record.dbId);
    console.log(
      `[TursoReplicaCutover] Cleared stale cutoverInProgress for ${record.dbId} (already replica)`,
    );
    return { resumed: true, action: "cleared" };
  }

  const restored = await restoreLocalDbFromPreReplicaBackup(record.localPath);
  await clearCutoverInProgress(record.dbId);
  console.warn(
    `[TursoReplicaCutover] Resumed interrupted cutover for ${record.dbId} — ` +
      `restored backup=${restored}`,
  );
  return { resumed: true, action: restored ? "restored" : "cleared" };
}

/** Scan registry for interrupted cutovers (gateway startup). */
export async function resumeAllInterruptedReplicaCutovers(): Promise<number> {
  await initializeDatabaseRegistry();
  const registry = getDatabaseRegistryService();
  const interrupted = registry
    .listActive()
    .filter((record) => record.cutoverInProgress === true);

  let count = 0;
  for (const record of interrupted) {
    await resumeInterruptedReplicaCutover(record);
    count += 1;
  }
  return count;
}

async function runLegacyPushBeforeCutover(
  record: DatabaseRecord,
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  try {
    await pushLocalLegacyFileToTursoPrimary(record);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function finalizeReplicaCutover(record: DatabaseRecord): Promise<void> {
  const registry = getDatabaseRegistryService();
  const replica = getTursoReplicaService();
  await replica.close(record.localPath);

  // Provision while still legacy — only flip syncMode after success (no half-switch).
  await provisionTursoReplicaForCutover(record);

  await registry.markSyncModeReplicaCutover(record.dbId);

  await registry.updateReplicaPushState(record.dbId, {
    lastReplicaPushError: null,
    cutoverBlocked: false,
    cutoverBlockReason: null,
    cutoverInProgress: false,
    cutoverStartedAt: null,
  });
}

/** Run cutover for one legacy registry database. */
export async function runCutoverForRecord(
  record: DatabaseRecord,
  options?: {
    dryRun?: boolean;
    forceRetry?: boolean;
    allowWithoutProductionAck?: boolean;
  },
): Promise<CutoverRunResult> {
  const dryRun = options?.dryRun === true;

  if (options?.forceRetry && record.cutoverBlocked) {
    const registry = getDatabaseRegistryService();
    await registry.updateReplicaPushState(record.dbId, {
      cutoverBlocked: false,
      cutoverBlockReason: null,
    });
    const refreshed = registry.getById(record.dbId);
    if (refreshed) {
      record = refreshed;
    }
  }

  const classification = await classifyRecordForReplicaCutover(record);

  const skipBuckets = new Set(["skip", "cloud_off"]);
  if (skipBuckets.has(classification.bucket)) {
    return {
      dbId: record.dbId,
      dryRun,
      classification,
      ok: true,
      skipped: true,
    };
  }

  if (classification.bucket === "blocked") {
    return {
      dbId: record.dbId,
      dryRun,
      classification,
      ok: false,
      skipped: true,
      blocked: true,
      error: classification.reason,
    };
  }

  if (dryRun) {
    return {
      dbId: record.dbId,
      dryRun: true,
      classification,
      ok: true,
    };
  }

  if (!isCutoverExecutionAllowed(options)) {
    return {
      dbId: record.dbId,
      dryRun: false,
      classification,
      ok: false,
      skipped: true,
      error:
        "Cutover skipped — set PAPR_TURSO_REPLICA_SYNC_ALLOW_PRODUCTION=1 to execute",
    };
  }

  const registry = getDatabaseRegistryService();
  let backupPath: string | undefined;

  if (record.cutoverInProgress) {
    await resumeInterruptedReplicaCutover(record);
    const refreshed = registry.getById(record.dbId);
    if (refreshed) {
      record = refreshed;
    }
  }

  try {
    await markCutoverInProgress(record.dbId);
    backupPath = await backupLocalDbPreReplica(record.localPath);

    const strippedArtifacts = stripLegacyCdcArtifacts(record.localPath);
    if (strippedArtifacts.length > 0) {
      console.log(
        `[TursoReplicaCutover] Stripped legacy CDC artifacts from ${record.dbId}: ` +
          strippedArtifacts.join(", "),
      );
    }

    const needsLegacyPush =
      (classification.bucket === "seed_local" &&
        classification.snapshot.localTableCount > 0) ||
      (classification.bucket === "pull_remote" &&
        classification.snapshot.dirty);

    let legacyPush:
      | { ok: boolean; error?: string; skipped?: boolean }
      | undefined;
    if (needsLegacyPush) {
      legacyPush = await runLegacyPushBeforeCutover(record);
      if (!legacyPush.ok) {
        await blockCutover(
          record.dbId,
          legacyPush.error ?? "Legacy push failed before cutover",
        );
        return {
          dbId: record.dbId,
          dryRun: false,
          classification,
          ok: false,
          blocked: true,
          backupPath,
          legacyPush,
          error: legacyPush.error,
        };
      }
    }

    if (!fs.existsSync(record.localPath) && classification.bucket === "pull_remote") {
      await blockCutover(record.dbId, "Local database file missing before cutover");
      return {
        dbId: record.dbId,
        dryRun: false,
        classification,
        ok: false,
        blocked: true,
        backupPath,
        error: "Local database file missing before cutover",
      };
    }

    await finalizeReplicaCutover(record);

    return {
      dbId: record.dbId,
      dryRun: false,
      classification,
      ok: true,
      backupPath,
      legacyPush,
    };
  } catch (error) {
    const message = (error as Error).message;
    await restoreLocalDbFromPreReplicaBackup(record.localPath);
    await clearCutoverInProgress(record.dbId);

    const stillLegacy = registry.getById(record.dbId)?.syncMode !== "replica";
    if (stillLegacy) {
      await blockCutover(record.dbId, message);
    } else {
      await registry.updateReplicaPushState(record.dbId, {
        lastReplicaPushError: message.slice(0, 500),
        cutoverBlocked: true,
        cutoverBlockReason: message.slice(0, 500),
      });
    }

    return {
      dbId: record.dbId,
      dryRun: false,
      classification,
      ok: false,
      blocked: true,
      backupPath,
      error: message,
    };
  }
}

/** Classify linked legacy registry databases (no mutations). */
export async function classifyPendingReplicaCutovers(options?: {
  dbId?: string;
  linkedOnly?: boolean;
}): Promise<CutoverClassification[]> {
  const linkedOnly = options?.linkedOnly !== false;
  const candidates = linkedOnly
    ? await listLinkedLegacyCutoverCandidates({ dbId: options?.dbId })
    : await listAllLegacyCutoverCandidates({ dbId: options?.dbId });
  return Promise.all(
    candidates.map((record) => classifyRecordForReplicaCutover(record)),
  );
}

async function listAllLegacyCutoverCandidates(options?: {
  dbId?: string;
}): Promise<DatabaseRecord[]> {
  await initializeDatabaseRegistry();
  const registry = getDatabaseRegistryService();
  let candidates = registry.listActive().filter(
    (record) => record.syncMode !== "replica",
  );
  if (options?.dbId) {
    candidates = candidates.filter((record) => record.dbId === options.dbId);
  }
  return candidates;
}

function summarizeCutoverBatch(
  results: CutoverRunResult[],
  dryRun: boolean,
): CutoverBatchResult {
  let succeeded = 0;
  let blocked = 0;
  let skipped = 0;
  for (const result of results) {
    if (result.skipped) {
      skipped += 1;
    } else if (result.ok) {
      succeeded += 1;
    } else if (result.blocked) {
      blocked += 1;
    }
  }

  return {
    dryRun,
    results,
    attempted: results.filter((r) => !r.skipped).length,
    succeeded,
    blocked,
    skipped,
  };
}

/** User clicked Upload now — cutover only this app's linked legacy registry DBs. */
export async function runReplicaCutoverForAppUpload(
  appId: string,
): Promise<CutoverBatchResult> {
  if (!shouldRunReplicaCutover()) {
    return emptyCutoverBatch(false);
  }

  const candidates = await listLegacyCutoverCandidatesForApp(appId);
  if (candidates.length === 0) {
    return emptyCutoverBatch(false);
  }

  const results: CutoverRunResult[] = [];
  for (const record of candidates) {
    results.push(
      await runCutoverForRecord(record, {
        // Upload now is an explicit user retry — clear prior cutoverBlocked.
        forceRetry: true,
        allowWithoutProductionAck: true,
      }),
    );
  }

  return summarizeCutoverBatch(results, false);
}

export function formatReplicaCutoverUploadFailure(
  batch: CutoverBatchResult,
): string | null {
  const failed = batch.results.filter(
    (result) => !result.ok && (!result.skipped || result.blocked === true),
  );
  if (failed.length === 0) {
    return null;
  }
  const parts = failed.map((result) => {
    const detail = result.error ?? result.classification.reason;
    return `${result.dbId}${detail ? `: ${detail}` : ""}`;
  });
  return `Replica cutover failed — ${parts.join("; ")}`;
}

/** Run cutover for eligible linked legacy registry databases. */
export async function runPendingReplicaCutovers(options?: {
  dryRun?: boolean;
  dbId?: string;
  forceRetry?: boolean;
  linkedOnly?: boolean;
  allowWithoutProductionAck?: boolean;
  /** Gateway startup batch — off unless PAPR_TURSO_REPLICA_CUTOVER_ON_STARTUP=1 */
  fromStartup?: boolean;
}): Promise<CutoverBatchResult> {
  if (!shouldRunReplicaCutover() && !options?.dryRun) {
    return emptyCutoverBatch(options?.dryRun === true);
  }

  if (
    options?.fromStartup &&
    !options.dryRun &&
    !options.dbId &&
    !shouldRunReplicaCutoverOnStartup()
  ) {
    return emptyCutoverBatch(false);
  }

  if (
    !options?.dryRun &&
    !options?.dbId &&
    getWorkspaceSwitchHealthStatus() === "switching"
  ) {
    console.warn(
      "[TursoReplicaCutover] Skipping batch cutover — workspace switch in progress",
    );
    return emptyCutoverBatch(false);
  }

  if (!options?.dryRun) {
    const resumed = await resumeAllInterruptedReplicaCutovers();
    if (resumed > 0) {
      console.log(
        `[TursoReplicaCutover] Resumed ${resumed} interrupted cutover(s) from prior session`,
      );
    }
  }

  const linkedOnly = options?.linkedOnly !== false;
  const candidates = linkedOnly
    ? await listLinkedLegacyCutoverCandidates({ dbId: options?.dbId })
    : await listAllLegacyCutoverCandidates({ dbId: options?.dbId });

  const results: CutoverRunResult[] = [];
  for (const record of candidates) {
    results.push(
      await runCutoverForRecord(record, {
        dryRun: options?.dryRun,
        forceRetry: options?.forceRetry,
        allowWithoutProductionAck: options?.allowWithoutProductionAck,
      }),
    );
  }

  return summarizeCutoverBatch(results, options?.dryRun === true);
}

function emptyCutoverBatch(dryRun: boolean): CutoverBatchResult {
  return {
    dryRun,
    results: [],
    attempted: 0,
    succeeded: 0,
    blocked: 0,
    skipped: 0,
  };
}

/** Retry cutover for one db after repair cleared blockers (legacy syncMode only). */
export async function retryReplicaCutoverAfterRepair(
  dbId: string,
): Promise<CutoverRunResult | null> {
  if (!shouldRunReplicaCutover()) {
    return null;
  }
  await initializeDatabaseRegistry();
  const record = getDatabaseRegistryService().getById(dbId);
  if (!record || record.status !== "active" || record.syncMode === "replica") {
    return null;
  }
  return runCutoverForRecord(record, {
    forceRetry: true,
    allowWithoutProductionAck: true,
  });
}
