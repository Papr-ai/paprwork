/**
 * Per-source Turso sync status for Settings UI.
 */

import * as fs from "fs";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import {
  filterSyncableTables,
  listUserTables,
  openWritableLocalJobDb,
} from "./tursoSyncBridgeCore.js";
import { jobTursoDatabaseName } from "./tursoDatabaseNaming.js";
import {
  discoverTursoLinkedSources,
  linkedSourceAsAppDataSource,
  linkedSourceSyncKey,
  listAppsLinkingDbPath,
  type TursoLinkedSource,
} from "./tursoLinkedSources.js";
import { ensureTursoSyncBridge } from "./TursoSyncBridge.js";
import { isJobDbDirty, loadTursoSyncState } from "./tursoSyncState.js";
import { localRemoteUserSchemaDriftTables } from "./tursoDeltaSync.js";
import { getDatabaseRegistryService,
} from "./DatabaseRegistryService.js";
import { shouldAutoUploadTursoForApp } from "./cloudUploadMode.js";
import { listLegacyCdcArtifactTablesForPath } from "./legacyCdcArtifacts.js";
import type { TursoReplicaSyncStatus } from "./tursoReplica/tursoReplicaTypes.js";
import {
  shouldUseTursoReplicaForSource,
  syncStatusForLinkedDb,
} from "./tursoReplica/tursoReplicaRouting.js";

export type TursoSourceSyncState =
  | "synced"
  | "pending"
  | "empty"
  | "unavailable"
  | "quarantined";

export interface TursoSourceSyncItem {
  appId: string;
  jobId: string;
  alias: string;
  role: string;
  dbPath: string;
  tursoDatabase: string;
  status: TursoSourceSyncState;
  localTableCount: number;
  remoteTableCount: number;
  schemaDrift?: boolean;
  /** Local-only legacy CDC tables excluded from drift (diagnostic). */
  legacyArtifactTables?: string[];
  /** Other mini-apps linking the same on-disk SQLite file (shared registry DB). */
  linkingAppIds?: string[];
  /** Turso token/query failed — remoteTableCount may be misleading. */
  remoteCheckFailed?: boolean;
  quarantinedAt?: string | null;
  quarantineReason?: string | null;
  /** Dirty but auto-upload off — use Upload now. */
  manualUploadHold?: boolean;
  /** Plan A replica path — when set, row sync uses Turso Sync push/pull. */
  syncMode?: "legacy" | "replica";
  online?: boolean;
  pendingPush?: boolean;
  pendingOps?: number;
  migrationConflict?: boolean;
  lastReplicaPushError?: string | null;
  cutoverBlocked?: boolean;
  cutoverBlockReason?: string | null;
}

export interface TursoSyncItemsReport {
  enabled: boolean;
  databaseMode: "per-job";
  lastCheckedAt: string;
  error: string | null;
  sources: TursoSourceSyncItem[];
  summary: {
    synced: number;
    pending: number;
    empty: number;
    unavailable: number;
    quarantined: number;
    total: number;
  };
}

function countLocalSyncableTables(dbPath: string): number {
  if (!fs.existsSync(dbPath)) {
    return 0;
  }
  try {
    const stats = fs.statSync(dbPath);
    if (stats.size === 0) {
      return 0;
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      return filterSyncableTables(listUserTables(db)).length;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

async function countLocalSyncableTablesForSource(
  source: TursoLinkedSource,
): Promise<number> {
  const appSource = linkedSourceAsAppDataSource(source);
  if (shouldUseTursoReplicaForSource(appSource)) {
    try {
      const { queryLinkedDbViaTursoReplica } = await import(
        "./tursoReplica/tursoReplicaRouting.js"
      );
      const result = await queryLinkedDbViaTursoReplica(
        appSource,
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        [],
        { pullBeforeRead: false },
      );
      return filterSyncableTables(
        result.rows.map((row) => String(row.name ?? row[0] ?? "")),
      ).length;
    } catch {
      return 0;
    }
  }
  return countLocalSyncableTables(source.dbPath);
}

/** Exported for unit tests — fingerprint-aware Turso source status. */
export function resolveTursoSourceStatus(
  localTableCount: number,
  remoteTableCount: number,
  dbExists: boolean,
  dirty: boolean,
  quarantined = false,
  schemaDrift = false,
  remoteCheckFailed = false,
): TursoSourceSyncState {
  if (quarantined) {
    return "quarantined";
  }
  if (!dbExists) {
    return "unavailable";
  }
  if (remoteCheckFailed && localTableCount > 0) {
    return "unavailable";
  }
  if (schemaDrift && localTableCount > 0 && remoteTableCount > 0) {
    return "pending";
  }
  if (dirty && localTableCount > 0) {
    return "pending";
  }
  if (localTableCount > 0 && remoteTableCount > 0 && localTableCount > remoteTableCount) {
    return "pending";
  }
  if (remoteTableCount > 0 && !schemaDrift) {
    return "synced";
  }
  if (localTableCount > 0) {
    return "pending";
  }
  return "empty";
}

/** Exported for unit tests — replica-aware Turso source status. */
export function resolveReplicaTursoSourceStatus(
  localTableCount: number,
  dbExists: boolean,
  replica: Pick<
    TursoReplicaSyncStatus,
    "pendingPush" | "migrationConflict" | "cutoverBlocked"
  >,
  quarantined = false,
): TursoSourceSyncState {
  if (quarantined) {
    return "quarantined";
  }
  if (!dbExists) {
    return "unavailable";
  }
  if (replica.cutoverBlocked || replica.migrationConflict || replica.pendingPush) {
    return "pending";
  }
  if (localTableCount > 0) {
    return "synced";
  }
  return "empty";
}

function summarize(items: TursoSourceSyncItem[]): TursoSyncItemsReport["summary"] {
  let synced = 0;
  let pending = 0;
  let empty = 0;
  let unavailable = 0;
  let quarantined = 0;
  for (const item of items) {
    if (item.status === "synced") synced += 1;
    else if (item.status === "pending") pending += 1;
    else if (item.status === "empty") empty += 1;
    else if (item.status === "quarantined") quarantined += 1;
    else unavailable += 1;
  }
  return { synced, pending, empty, unavailable, quarantined, total: items.length };
}

function resolveTursoDatabaseLabel(source: TursoLinkedSource): string {
  const registry = getDatabaseRegistryService();
  if (source.dbId) {
    const record = registry.getById(source.dbId);
    if (record) {
      return record.tursoShortName;
    }
  }
  const byPath = registry.getByPath(source.dbPath);
  if (byPath) {
    return byPath.tursoShortName;
  }
  if (source.jobId) {
    return jobTursoDatabaseName(source.jobId);
  }
  return linkedSourceSyncKey(source);
}

function sourceItem(
  source: TursoLinkedSource,
  localTableCount: number,
  remoteTableCount: number,
  dirty: boolean,
  schemaDrift: boolean,
  pushState: ReturnType<typeof loadTursoSyncState>,
  remoteCheckFailed = false,
  linkingAppIds?: string[],
  replica?: TursoReplicaSyncStatus,
  legacyArtifactTables?: string[],
): TursoSourceSyncItem {
  const dbExists = fs.existsSync(source.dbPath);
  const syncKey = linkedSourceSyncKey(source);
  const jobState = pushState.jobs[syncKey];
  const quarantined = Boolean(jobState?.quarantinedAt);
  const status =
    replica?.syncMode === "replica"
      ? resolveReplicaTursoSourceStatus(
          localTableCount,
          dbExists,
          replica,
          quarantined,
        )
      : resolveTursoSourceStatus(
          localTableCount,
          remoteTableCount,
          dbExists,
          dirty,
          quarantined,
          schemaDrift,
          remoteCheckFailed,
        );
  const manualUploadHold =
    !shouldAutoUploadTursoForApp(source.appId) &&
    status === "pending" &&
    (replica?.syncMode === "replica" ? replica.pendingPush : dirty);
  return {
    appId: source.appId,
    jobId: syncKey,
    alias: source.alias,
    role: source.role ?? "linked",
    dbPath: source.dbPath,
    tursoDatabase: resolveTursoDatabaseLabel(source),
    status,
    localTableCount,
    remoteTableCount,
    schemaDrift: replica?.syncMode === "replica" ? undefined : schemaDrift,
    legacyArtifactTables:
      legacyArtifactTables && legacyArtifactTables.length > 0
        ? legacyArtifactTables
        : undefined,
    quarantinedAt: jobState?.quarantinedAt ?? null,
    quarantineReason: jobState?.quarantineReason ?? null,
    manualUploadHold: manualUploadHold || undefined,
    remoteCheckFailed: remoteCheckFailed || undefined,
    linkingAppIds:
      linkingAppIds && linkingAppIds.length > 1 ? linkingAppIds : undefined,
    ...(replica?.syncMode === "replica"
      ? {
          syncMode: "replica" as const,
          online: replica.online,
          pendingPush: replica.pendingPush,
          pendingOps: replica.pendingOps,
          migrationConflict: replica.migrationConflict || undefined,
          lastReplicaPushError: replica.lastPushError,
          cutoverBlocked: replica.cutoverBlocked || undefined,
          cutoverBlockReason: replica.cutoverBlockReason,
        }
      : {}),
  };
}

async function detectRemoteSchemaDrift(
  dbPath: string,
  tursoDatabase: string,
): Promise<boolean> {
  const { isReplicaManagedDbPath } = await import(
    "./tursoReplica/tursoReplicaFileGuard.js"
  );
  if (isReplicaManagedDbPath(dbPath)) {
    return false;
  }
  if (!fs.existsSync(dbPath)) {
    return false;
  }
  const bridge = ensureTursoSyncBridge();
  if (!bridge.enabled) {
    return false;
  }
  return bridge.runExclusiveForDbPath(dbPath, async () => {
    let credentials;
    try {
      credentials = await bridge.fetchCredentials(tursoDatabase);
    } catch {
      return false;
    }
    const remote = createClient({
      url: credentials.tursoUrl,
      authToken: credentials.authToken,
    });
    const localDb = openWritableLocalJobDb(dbPath);
    try {
      const tableNames = filterSyncableTables(listUserTables(localDb));
      if (tableNames.length === 0) {
        return false;
      }
      const drifted = await localRemoteUserSchemaDriftTables(remote, localDb, tableNames);
      return drifted.length > 0;
    } finally {
      localDb.close();
      remote.close();
    }
  });
}

async function countRemoteSyncableTables(
  tursoDatabase: string,
  dbPath: string,
): Promise<number> {
  const bridge = ensureTursoSyncBridge();
  if (!bridge.enabled) {
    return 0;
  }
  return bridge.runExclusiveForDbPath(dbPath, async () => {
    const credentials = await bridge.fetchCredentials(tursoDatabase);
    const remote = createClient({
      url: credentials.tursoUrl,
      authToken: credentials.authToken,
    });
    try {
      const result = await remote.execute(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      );
      return filterSyncableTables(
        result.rows.map((row) => String(row.name ?? "")),
      ).length;
    } finally {
      remote.close();
    }
  });
}

interface DbRemoteCheckSnapshot {
  remoteTableCount: number;
  schemaDrift: boolean;
  remoteCheckFailed: boolean;
}

async function snapshotDbRemoteCheck(
  dbPath: string,
  tursoDatabase: string,
  localTableCount: number,
  replicaManaged = false,
): Promise<DbRemoteCheckSnapshot> {
  let remoteTableCount = 0;
  let schemaDrift = false;
  let remoteCheckFailed = false;
  try {
    remoteTableCount = await countRemoteSyncableTables(tursoDatabase, dbPath);
    if (
      !replicaManaged &&
      remoteTableCount > 0 &&
      localTableCount > 0
    ) {
      schemaDrift = await detectRemoteSchemaDrift(dbPath, tursoDatabase);
    }
  } catch {
    remoteCheckFailed = true;
  }
  return { remoteTableCount, schemaDrift, remoteCheckFailed };
}

export async function buildTursoSyncItemsReport(
  appsRootDir: string,
  filterAppId?: string,
): Promise<TursoSyncItemsReport> {
  const emptyReport = (error: string | null): TursoSyncItemsReport => ({
    enabled: false,
    databaseMode: "per-job",
    lastCheckedAt: new Date().toISOString(),
    error,
    sources: [],
    summary: { synced: 0, pending: 0, empty: 0, unavailable: 0, quarantined: 0, total: 0 },
  });

  const bridge = ensureTursoSyncBridge();
  if (!bridge.enabled) {
    return emptyReport("Turso sync is disabled");
  }

  const allSources = await discoverTursoLinkedSources(appsRootDir);
  const sources = filterAppId
    ? allSources.filter((source) => source.appId === filterAppId)
    : allSources;
  if (sources.length === 0) {
    return {
      enabled: true,
      databaseMode: "per-job",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      sources: [],
      summary: { synced: 0, pending: 0, empty: 0, unavailable: 0, quarantined: 0, total: 0 },
    };
  }

  const items: TursoSourceSyncItem[] = [];
  let reportError: string | null = null;
  const pushState = loadTursoSyncState();
  const remoteByDbPath = new Map<string, DbRemoteCheckSnapshot>();
  const artifactsByDbPath = new Map<string, string[]>();

  for (const source of sources) {
    const syncKey = linkedSourceSyncKey(source);
    const appSource = linkedSourceAsAppDataSource(source);
    const replicaManaged = shouldUseTursoReplicaForSource(appSource);
    const localTableCount = await countLocalSyncableTablesForSource(source);
    const alternateKeys = source.jobId && source.jobId !== syncKey ? [source.jobId] : [];
    const dirty = replicaManaged
      ? false
      : isJobDbDirty(syncKey, source.dbPath, pushState, alternateKeys);
    const tursoDatabase = resolveTursoDatabaseLabel(source);
    const dbPathKey = source.dbPath;
    let remoteSnapshot = remoteByDbPath.get(dbPathKey);
    if (!remoteSnapshot) {
      try {
        remoteSnapshot = await snapshotDbRemoteCheck(
          source.dbPath,
          tursoDatabase,
          localTableCount,
          replicaManaged,
        );
      } catch (err) {
        remoteSnapshot = {
          remoteTableCount: 0,
          schemaDrift: false,
          remoteCheckFailed: true,
        };
        reportError = (err as Error).message.slice(0, 200);
      }
      remoteByDbPath.set(dbPathKey, remoteSnapshot);
    }
    let legacyArtifactTables = artifactsByDbPath.get(dbPathKey);
    if (!legacyArtifactTables) {
      legacyArtifactTables = listLegacyCdcArtifactTablesForPath(source.dbPath);
      artifactsByDbPath.set(dbPathKey, legacyArtifactTables);
    }
    const linkingAppIds = listAppsLinkingDbPath(allSources, source.dbPath);
    let replicaStatus: TursoReplicaSyncStatus | undefined;
    if (replicaManaged) {
      try {
        replicaStatus = await syncStatusForLinkedDb(appSource);
      } catch {
        /* best-effort — fall back to legacy CDC status */
      }
    }
    items.push(
      sourceItem(
        source,
        localTableCount,
        remoteSnapshot.remoteTableCount,
        dirty,
        remoteSnapshot.schemaDrift,
        pushState,
        remoteSnapshot.remoteCheckFailed,
        linkingAppIds,
        replicaStatus,
        legacyArtifactTables,
      ),
    );
  }

  items.sort((a, b) => a.alias.localeCompare(b.alias));

  return {
    enabled: true,
    databaseMode: "per-job",
    lastCheckedAt: new Date().toISOString(),
    error: reportError,
    sources: items,
    summary: summarize(items),
  };
}
