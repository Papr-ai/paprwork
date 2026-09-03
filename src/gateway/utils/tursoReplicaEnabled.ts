/**
 * Feature gates for Plan A Turso Sync replica path (vs legacy CDC/log sync).
 */

import { isCloudSyncEnabled } from "./cloudSyncEnabled.js";
import {
  isTursoReplicaReachable,
  markTursoReplicaReachable,
  resetTursoReplicaConnectivityForTests,
} from "./tursoReplicaConnectivity.js";
import type { DatabaseSyncMode } from "../services/tursoReplica/tursoReplicaTypes.js";

export type TursoReplicaRolloutMode = "off" | "replica-records" | "force";

/** How replica sync is rolled out on desktop. */
export function tursoReplicaRolloutMode(): TursoReplicaRolloutMode {
  const raw = process.env.PAPR_TURSO_REPLICA_SYNC?.trim().toLowerCase();
  if (raw === "force" || raw === "true" || raw === "1") {
    return "force";
  }
  if (raw === "replica-records" || raw === "records") {
    return "replica-records";
  }
  return "off";
}

export function isTursoReplicaSyncFeatureEnabled(): boolean {
  return tursoReplicaRolloutMode() !== "off";
}

/**
 * Run pull()/push() in a child process so a panic in the native sync engine cannot abort
 * the gateway along with the app.
 *
 * Opt-in. Isolation is not free: the parent has to release the replica while the worker
 * holds it, so each sync costs an extra connect. Default off until a canary build confirms
 * the added latency is acceptable on the write path.
 */
export function isTursoSyncIsolationEnabled(): boolean {
  const raw = process.env.PAPR_TURSO_SYNC_ISOLATION?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/** Phase 1: online when cloud sync is on unless tests force offline. */
let replicaOnlineOverride: boolean | null = null;

export function setTursoReplicaOnlineForTests(online: boolean | null): void {
  replicaOnlineOverride = online;
  if (online === true) {
    markTursoReplicaReachable();
  }
  if (online === null) {
    resetTursoReplicaConnectivityForTests();
  }
}

export function isTursoReplicaOnline(): boolean {
  if (replicaOnlineOverride !== null) {
    return replicaOnlineOverride;
  }
  if (!isCloudSyncEnabled()) {
    return false;
  }
  return isTursoReplicaReachable();
}

/** Default sync mode for newly registered standalone databases. */
export function defaultSyncModeForNewRegistryDb(): DatabaseSyncMode | undefined {
  if (!isCloudSyncEnabled() || !isTursoReplicaSyncFeatureEnabled()) {
    return undefined;
  }
  const rollout = tursoReplicaRolloutMode();
  if (rollout === "force" || rollout === "replica-records") {
    return "replica";
  }
  return undefined;
}

export function shouldDeferRegistrySqliteFileForReplica(): boolean {
  return defaultSyncModeForNewRegistryDb() === "replica";
}

/**
 * Legacy workspace-log row sync (CDC + LogMaterializer).
 *
 * Stays on for uncutover apps even during Plan A rollout. Replica-mode DBs
 * skip legacy push/pull via shouldSuppressLegacyTursoPushForLinkedSource().
 */
export function isLegacyWorkspaceRowSyncEnabled(): boolean {
  return isCloudSyncEnabled();
}

/** Phase 3: auto-cutover legacy registry DBs when Plan A rollout is active. */
export function shouldRunReplicaCutover(): boolean {
  if (!isCloudSyncEnabled() || !isTursoReplicaSyncFeatureEnabled()) {
    return false;
  }
  const rollout = tursoReplicaRolloutMode();
  return rollout === "replica-records" || rollout === "force";
}

/**
 * Batch cutover on gateway startup (default off).
 * User-initiated Upload now runs cutover per app instead.
 */
export function shouldRunReplicaCutoverOnStartup(): boolean {
  return process.env.PAPR_TURSO_REPLICA_CUTOVER_ON_STARTUP === "1";
}

export function shouldUseTursoReplicaForDb(options: {
  syncMode?: DatabaseSyncMode;
}): boolean {
  if (!isCloudSyncEnabled() || !isTursoReplicaSyncFeatureEnabled()) {
    return false;
  }
  const rollout = tursoReplicaRolloutMode();
  if (rollout === "force") {
    return true;
  }
  // replica-records: only databases explicitly marked syncMode=replica
  return options.syncMode === "replica";
}

/** Log startup guard when Plan A rollout env is active. */
export function logTursoReplicaStartupGuard(): void {
  const mode = tursoReplicaRolloutMode();
  if (mode === "off") {
    return;
  }
  console.warn(
    `[TursoReplica] Plan A rollout=${mode} — new registry DBs default to replica; ` +
      "uncutover apps keep legacy workspace-log sync until Upload.",
  );
  console.warn(
    "[TursoReplica] Legacy → replica cutover runs on Upload now (per app). " +
      "Untouched apps stay on legacy sync until the user uploads.",
  );
  if (process.env.PAPR_TURSO_REPLICA_CUTOVER_ON_STARTUP === "1") {
    console.warn(
      "[TursoReplica] PAPR_TURSO_REPLICA_CUTOVER_ON_STARTUP=1 — batch cutover on gateway startup enabled.",
    );
  }
}
