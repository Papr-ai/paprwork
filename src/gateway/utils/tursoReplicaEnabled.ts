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

/**
 * Turso Sync engine builds that upstream actually publishes (see
 * `@tursodatabase/sync` optionalDependencies). Anything not listed — Intel Mac
 * (darwin-x64), Windows ARM (win32-arm64), musl Linux — has no engine and
 * uses cloud-direct instead.
 */
export const TURSO_SYNC_NATIVE_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@tursodatabase/sync-darwin-arm64",
  "win32-x64": "@tursodatabase/sync-win32-x64-msvc",
  "linux-x64": "@tursodatabase/sync-linux-x64-gnu",
  "linux-arm64": "@tursodatabase/sync-linux-arm64-gnu",
};

/** Engine package for a platform/arch pair, or null when upstream ships none. */
export function tursoSyncNativePackageFor(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  return TURSO_SYNC_NATIVE_PACKAGES[`${platform}-${arch}`] ?? null;
}

/**
 * True when upstream publishes a Turso Sync engine build for this OS/CPU.
 *
 * Deliberately a table lookup, not a runtime `require.resolve`: resolution
 * inside a packaged asar is fragile, and a false negative would silently move
 * every Apple Silicon user off the replica engine. Presence of the binding in
 * each packaged build is verified in CI (scripts/verify-packaged-turso-sync.mjs).
 *
 * `PAPR_TURSO_REPLICA_NATIVE=0|1` overrides (tests; kill switch if a shipped
 * binding turns out broken on some machine).
 */
export function isTursoReplicaNativeAvailable(): boolean {
  const override = process.env.PAPR_TURSO_REPLICA_NATIVE?.trim();
  if (override === "0") {
    return false;
  }
  if (override === "1") {
    return true;
  }
  return tursoSyncNativePackageFor() !== null;
}

export function isTursoReplicaSyncFeatureEnabled(): boolean {
  if (!isTursoReplicaNativeAvailable()) {
    return false;
  }
  return tursoReplicaRolloutMode() !== "off";
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

/**
 * The one decision for how a NEW database is stored on this device.
 *
 *   replica      — Turso Sync engine available: local replica file, synced.
 *   cloud-direct — rollout on, cloud sync on, but no engine build for this
 *                  OS/CPU (Intel Mac, Windows ARM): no local file; every read,
 *                  write and migration goes to the Turso primary over HTTP.
 *   undefined    — cloud sync off / rollout off: plain local SQLite (legacy).
 *
 * `hasExistingLocalData` keeps a database that already has a populated local
 * file (promotion, bundle import) on the local path — cloud-direct would
 * otherwise orphan those rows.
 */
export function chooseSyncModeForNewDatabase(options?: {
  hasExistingLocalData?: boolean;
}): DatabaseSyncMode | undefined {
  if (!isCloudSyncEnabled()) {
    return undefined;
  }
  const rollout = tursoReplicaRolloutMode();
  if (rollout === "off") {
    return undefined;
  }
  if (isTursoReplicaNativeAvailable()) {
    return "replica";
  }
  if (options?.hasExistingLocalData) {
    return undefined;
  }
  if (process.env.PAPR_CLOUD_DIRECT === "0") {
    return undefined;
  }
  return "cloud-direct";
}

/** Default sync mode for newly registered standalone databases. */
export function defaultSyncModeForNewRegistryDb(options?: {
  hasExistingLocalData?: boolean;
}): DatabaseSyncMode | undefined {
  return chooseSyncModeForNewDatabase(options);
}

/**
 * Sync mode for a database attached by a cloud install.
 *
 * Fork / private copy: a brand-new database — same choice as create_database.
 * Team shared database: keep the publisher's mode where this device can run it;
 * on a device with no engine, read/write the shared primary directly instead
 * of silently not syncing (a replica-owned record is declined by legacy sync).
 */
export function syncModeForInstalledDatabase(input: {
  installDbPolicy: "fork_empty" | "shared_primary";
  publisherSyncMode?: DatabaseSyncMode;
}): DatabaseSyncMode | undefined {
  if (input.installDbPolicy === "fork_empty") {
    return chooseSyncModeForNewDatabase();
  }
  const fresh = chooseSyncModeForNewDatabase();
  if (fresh === "cloud-direct") {
    return "cloud-direct";
  }
  return input.publisherSyncMode;
}

export function isCloudDirectSyncMode(mode: DatabaseSyncMode | undefined): boolean {
  return mode === "cloud-direct";
}

/** New registry DBs whose local file must NOT be created by better-sqlite3. */
export function shouldDeferRegistrySqliteFileForReplica(): boolean {
  const mode = defaultSyncModeForNewRegistryDb();
  return mode === "replica" || mode === "cloud-direct";
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

/**
 * Plan B batch genesis (`runWorkspaceLogGenesisCutoverForAllLinkedSources`).
 * Retired when Plan A rollout is on — row authority is Turso primary; uncutover
 * legacy DBs cut over on Publish / app use, not via workspace-log snapshot.
 */
export function shouldRunWorkspaceLogGenesisBatch(): boolean {
  if (!isCloudSyncEnabled()) {
    return false;
  }
  return !isTursoReplicaSyncFeatureEnabled();
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
  if (!isTursoReplicaNativeAvailable()) {
    const pkg = tursoSyncNativePackageFor();
    console.warn(
      `[TursoReplica] No Turso Sync engine for ${process.platform}-${process.arch}` +
        (pkg ? ` (${pkg} not installed)` : " (no upstream build)") +
        ". New databases use cloud-direct (Turso primary over HTTP) when cloud sync is on.",
    );
    return;
  }
  const mode = tursoReplicaRolloutMode();
  if (mode === "off") {
    return;
  }
  console.warn(
    `[TursoReplica] Plan A rollout=${mode} — new registry DBs default to replica; ` +
      "uncutover apps keep legacy workspace-log sync until Upload.",
  );
  console.warn(
    "[TursoReplica] Legacy → replica cutover runs on Publish / Publish changes (per app). " +
      "Untouched apps stay on legacy sync until the user uploads.",
  );
  if (process.env.PAPR_TURSO_REPLICA_CUTOVER_ON_STARTUP === "1") {
    console.warn(
      "[TursoReplica] PAPR_TURSO_REPLICA_CUTOVER_ON_STARTUP=1 — batch cutover on gateway startup enabled.",
    );
  }
}
