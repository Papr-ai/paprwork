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
  linkedSourceSyncKey,
  type TursoLinkedSource,
} from "./tursoLinkedSources.js";
import { getTursoSyncBridge } from "./TursoSyncBridge.js";
import { isJobDbDirty, loadTursoSyncState } from "./tursoSyncState.js";
import { localRemoteUserSchemaDriftTables } from "./tursoDeltaSync.js";
import {
  getDatabaseRegistryService,
} from "./DatabaseRegistryService.js";

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
  quarantinedAt?: string | null;
  quarantineReason?: string | null;
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

/** Exported for unit tests — fingerprint-aware Turso source status. */
export function resolveTursoSourceStatus(
  localTableCount: number,
  remoteTableCount: number,
  dbExists: boolean,
  dirty: boolean,
  quarantined = false,
  schemaDrift = false,
): TursoSourceSyncState {
  if (quarantined) {
    return "quarantined";
  }
  if (!dbExists) {
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
): TursoSourceSyncItem {
  const dbExists = fs.existsSync(source.dbPath);
  const syncKey = linkedSourceSyncKey(source);
  const jobState = pushState.jobs[syncKey];
  const quarantined = Boolean(jobState?.quarantinedAt);
  return {
    appId: source.appId,
    jobId: syncKey,
    alias: source.alias,
    role: source.role ?? "linked",
    dbPath: source.dbPath,
    tursoDatabase: resolveTursoDatabaseLabel(source),
    status: resolveTursoSourceStatus(
      localTableCount,
      remoteTableCount,
      dbExists,
      dirty,
      quarantined,
      schemaDrift,
    ),
    localTableCount,
    remoteTableCount,
    schemaDrift,
    quarantinedAt: jobState?.quarantinedAt ?? null,
    quarantineReason: jobState?.quarantineReason ?? null,
  };
}

async function detectRemoteSchemaDrift(
  dbPath: string,
  tursoDatabase: string,
): Promise<boolean> {
  if (!fs.existsSync(dbPath)) {
    return false;
  }
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return false;
  }
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
}

async function countRemoteSyncableTables(
  tursoDatabase: string,
): Promise<number> {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return 0;
  }
  const databaseName = tursoDatabase;
  const credentials = await bridge.fetchCredentials(databaseName);
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

  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return emptyReport("Turso sync not initialized");
  }

  const sources = (await discoverTursoLinkedSources(appsRootDir)).filter(
    (source) => !filterAppId || source.appId === filterAppId,
  );
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

  for (const source of sources) {
    const syncKey = linkedSourceSyncKey(source);
    const localTableCount = countLocalSyncableTables(source.dbPath);
    const alternateKeys = source.jobId && source.jobId !== syncKey ? [source.jobId] : [];
    const dirty = isJobDbDirty(syncKey, source.dbPath, pushState, alternateKeys);
    let remoteTableCount = 0;
    let schemaDrift = false;
    const tursoDatabase = resolveTursoDatabaseLabel(source);
    try {
      remoteTableCount = await countRemoteSyncableTables(tursoDatabase);
      if (remoteTableCount > 0 && localTableCount > 0) {
        schemaDrift = await detectRemoteSchemaDrift(source.dbPath, tursoDatabase);
      }
    } catch (err) {
      reportError = (err as Error).message.slice(0, 200);
    }
    items.push(
      sourceItem(source, localTableCount, remoteTableCount, dirty, schemaDrift, pushState),
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
