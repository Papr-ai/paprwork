/**
 * TursoSyncBridge — boundary push/pull for app-linked job data ↔ Turso.
 *
 * One Turso DB per linked job (j-{jobId8}). Only SQLite sources registered in app
 * data-sources.json sync (primary/readonly). Scratch tables stay local.
 */

import * as fs from "fs";
import * as path from "path";
import { mergeCloudActingUserBody } from "../utils/cloudActingUser.js";
import { getPaprApiKey } from "../utils/keyResolver.js";
import { publishDbChanged } from "../utils/publishJobRunEvents.js";
import {
  getPaprAppsRoot,
  getPaprJobsRoot,
} from "../../core/utils/paprRoot.js";
import {
  discoverTursoLinkedSources,
  findLinkedSourceForJob,
  linkedSourceAlternateKeys,
  linkedSourceSyncKey,
  listLinkedJobIdsForTursoSync,
  resolveLinkedSourcesForTursoPush,
  resolveTursoDatabaseLabel,
  type TursoLinkedSource,
} from "./tursoLinkedSources.js";
import { jobTursoDatabaseName } from "./tursoDatabaseNaming.js";
import {
  backupLocalJobDb,
  createRemoteClient,
  filterSyncableTables,
  isTursoDatabaseLimitError,
  isTursoLocalDatabaseCorruptError,
  isTursoProvisioningRateLimitError,
  isTursoSqliteBindTypeError,
  listUserTables,
  openWritableLocalJobDb,
  pullTursoToLocalDb,
  pushLocalDbToTurso,
  readLocalTable,
  readTableSchema,
  removeLocalJobDbBackup,
  replaceRemoteTable,
  restoreLocalJobDb,
  type LocalJobDbBackup,
  type PullResult,
  type PullSourceSyncOptions,
  type PushResult,
  type TursoCredentials,
} from "./tursoSyncBridgeCore.js";
import { recordTursoPushQuarantine } from "./tursoSyncState.js";
import {
  localRemoteSchemaDriftTables,
  remoteMissingLocalTables,
  remoteNeedsBootstrap,
} from "./tursoDeltaSync.js";
import {
  applyPendingDatabaseMigrationsToTurso,
  resolveMigrationRootFromDbPath,
} from "./jobs/jobMigrationTursoSync.js";
import { migrateRemoteTableSchema } from "./tursoSchemaMigration.js";
import { ensureRemoteRowSyncColumns } from "./rowSyncColumns.js";
import { ensureRemoteTableSyncTriggers } from "./tursoSyncLog.js";
import {
  isJobDbDirty,
  loadTursoSyncState,
  localDbHasSyncableData,
  recordTursoRemoteVersion,
  resolveTursoPushStateEntry,
} from "./tursoSyncState.js";

export interface JobSyncResult {
  jobId: string;
  push?: PushResult;
  pull?: PullResult;
  error?: string;
}

export interface SyncSummary {
  attempted: number;
  pushed: number;
  pulled: number;
  skipped: number;
  failed: number;
  results: JobSyncResult[];
}

export interface PushJobOptions {
  tableNames?: string[];
  force?: boolean;
}

export interface TursoPushScopedOptions {
  appId?: string;
  jobId?: string;
  alias?: string;
  tursoDatabase?: string;
  tables?: string[];
  /** When true (default with no scope), only push dirty linked DBs. */
  dirtyOnly?: boolean;
}

export interface TursoPushScopedDatabase {
  syncKey: string;
  tursoDatabase: string;
  alias: string;
  appId: string;
  tables?: string[];
}

export interface TursoPushScopedResult extends SyncSummary {
  databases: TursoPushScopedDatabase[];
}

interface TursoTokenResponse {
  tursoUrl: string;
  authToken: string;
  database?: string;
}

interface CachedCredentials {
  creds: TursoCredentials;
  expiresAt: number;
}

function resolveMemoryServerBase(): string {
  if (process.env.PAPR_MEMORY_SERVER_URL) {
    return process.env.PAPR_MEMORY_SERVER_URL.replace(/\/$/, "");
  }
  if (process.env.PAPR_AI_PROXY_BASE_URL) {
    return process.env.PAPR_AI_PROXY_BASE_URL.replace(/\/v1\/ai\/?$/, "").replace(
      /\/$/,
      "",
    );
  }
  return "https://memory.papr.ai";
}

export class TursoSyncBridge {
  private readonly jobsRootOverride?: string;
  private readonly appsRootOverride?: string;
  private readonly memoryServerBase: string;
  private readonly enabled: boolean;
  private databaseLimitLogged = false;
  private linkedSourcesCache: TursoLinkedSource[] | null = null;
  private credentialsCacheByDb = new Map<string, CachedCredentials>();
  private credentialsFetchPromises = new Map<string, Promise<TursoCredentials>>();

  private static readonly CREDENTIALS_TTL_MS = 30 * 60_000;

  constructor(options?: {
    jobsRootDir?: string;
    appsRootDir?: string;
    memoryServerBase?: string;
    enabled?: boolean;
  }) {
    this.jobsRootOverride = options?.jobsRootDir;
    this.appsRootOverride = options?.appsRootDir;
    this.memoryServerBase = options?.memoryServerBase ?? resolveMemoryServerBase();
    this.enabled = options?.enabled ?? process.env.TURSO_SYNC_ENABLED !== "false";
  }

  private get jobsRootDir(): string {
    return this.jobsRootOverride ?? getPaprJobsRoot();
  }

  private get appsRootDir(): string {
    return this.appsRootOverride ?? getPaprAppsRoot();
  }

  getJobDatabasePath(jobId: string): string {
    return path.join(this.jobsRootDir, jobId, "data", "data.db");
  }

  tursoDatabaseNameForJob(jobId: string): string {
    return jobTursoDatabaseName(jobId);
  }

  private async resolveTursoDatabaseNameForLinked(
    linked: TursoLinkedSource,
  ): Promise<string> {
    const { getDatabaseRegistryService } = await import(
      "./DatabaseRegistryService.js"
    );
    const registry = getDatabaseRegistryService();
    if (linked.dbId) {
      const record = registry.getById(linked.dbId);
      if (record) {
        return record.tursoShortName;
      }
    }
    const byPath = registry.getByPath(linked.dbPath);
    if (byPath) {
      return byPath.tursoShortName;
    }
    if (linked.jobId) {
      return jobTursoDatabaseName(linked.jobId);
    }
    throw new Error(
      `Cannot resolve Turso database name for linked source ${linked.alias}`,
    );
  }

  async fetchCredentials(databaseName: string): Promise<TursoCredentials> {
    const now = Date.now();
    const cached = this.credentialsCacheByDb.get(databaseName);
    if (cached && cached.expiresAt > now) {
      return cached.creds;
    }

    const inFlight = this.credentialsFetchPromises.get(databaseName);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.fetchCredentialsUncached(databaseName)
      .then((creds) => {
        this.credentialsCacheByDb.set(databaseName, {
          creds,
          expiresAt: Date.now() + TursoSyncBridge.CREDENTIALS_TTL_MS,
        });
        this.credentialsFetchPromises.delete(databaseName);
        return creds;
      })
      .catch((error) => {
        this.credentialsFetchPromises.delete(databaseName);
        throw error;
      });

    this.credentialsFetchPromises.set(databaseName, promise);
    return promise;
  }

  invalidateCredentialsCache(databaseName?: string): void {
    if (databaseName) {
      this.credentialsCacheByDb.delete(databaseName);
      this.credentialsFetchPromises.delete(databaseName);
      return;
    }
    this.credentialsCacheByDb.clear();
    this.credentialsFetchPromises.clear();
  }

  private async fetchCredentialsUncached(
    databaseName: string,
  ): Promise<TursoCredentials> {
    const apiKey = await getPaprApiKey();
    if (!apiKey) {
      throw new Error("PAPR_API_KEY not configured");
    }

    const response = await fetch(
      `${this.memoryServerBase}/v1/cloud/databases/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify(
          mergeCloudActingUserBody({ database: databaseName }),
        ),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429 || isTursoDatabaseLimitError(body)) {
        this.logDatabaseLimitOnce();
        throw new Error(
          "Turso database limit reached — skipping cloud sync",
        );
      }
      if (isTursoProvisioningRateLimitError(body)) {
        this.invalidateCredentialsCache(databaseName);
        throw new Error(
          `Turso token request failed (${response.status}): ${body.slice(0, 200)}`,
        );
      }
      throw new Error(
        `Turso token request failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as TursoTokenResponse;
    if (!data.tursoUrl || !data.authToken) {
      throw new Error("Turso token response missing tursoUrl or authToken");
    }
    return { tursoUrl: data.tursoUrl, authToken: data.authToken };
  }

  async deleteTursoDatabaseByName(databaseName: string): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    const apiKey = await getPaprApiKey();
    if (!apiKey) {
      return false;
    }

    try {
      const response = await fetch(
        `${this.memoryServerBase}/v1/cloud/databases/delete`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
          },
          body: JSON.stringify(
          mergeCloudActingUserBody({ database: databaseName }),
        ),
          signal: AbortSignal.timeout(30_000),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        console.warn(
          `[TursoSyncBridge] Delete database ${databaseName} failed (${response.status}): ${body.slice(0, 120)}`,
        );
        return false;
      }

      const data = (await response.json()) as { deleted?: boolean };
      this.invalidateCredentialsCache(databaseName);
      return data.deleted === true;
    } catch (error) {
      console.warn(
        `[TursoSyncBridge] Delete database ${databaseName} error:`,
        (error as Error).message.slice(0, 120),
      );
      return false;
    }
  }

  async deleteJobTursoDatabase(jobId: string): Promise<boolean> {
    const databaseName = jobTursoDatabaseName(jobId);
    return this.deleteTursoDatabaseByName(databaseName);
  }

  getAppsRootDir(): string {
    return this.appsRootDir;
  }

  invalidateLinkedSourcesCache(): void {
    this.linkedSourcesCache = null;
  }

  async listLinkedSources(forceRefresh = false): Promise<TursoLinkedSource[]> {
    if (!forceRefresh && this.linkedSourcesCache) {
      return this.linkedSourcesCache;
    }
    const sources = await discoverTursoLinkedSources(this.appsRootDir);
    this.linkedSourcesCache = sources;
    return sources;
  }

  async listJobIdsForTursoSync(): Promise<string[]> {
    return listLinkedJobIdsForTursoSync(this.appsRootDir);
  }

  async isJobLinkedToApp(jobId: string): Promise<boolean> {
    const sources = await this.listLinkedSources();
    return findLinkedSourceForJob(sources, jobId) !== undefined;
  }

  /** True when fingerprints/mtime are dirty OR remote Turso lacks local user tables. */
  async linkedSourceNeedsPush(linked: TursoLinkedSource): Promise<boolean> {
    const syncKey = linkedSourceSyncKey(linked);
    const alternateKeys = linkedSourceAlternateKeys(linked);
    const state = loadTursoSyncState();
    if (isJobDbDirty(syncKey, linked.dbPath, state, alternateKeys)) {
      return true;
    }
    if (!localDbHasSyncableData(linked.dbPath)) {
      return false;
    }
    const databaseName = await this.resolveTursoDatabaseNameForLinked(linked);
    const creds = await this.fetchCredentials(databaseName);
    const remote = createRemoteClient(creds);
    try {
      if (await remoteNeedsBootstrap(remote)) {
        return true;
      }
      const localDb = openWritableLocalJobDb(linked.dbPath);
      try {
        const localTables = filterSyncableTables(listUserTables(localDb));
        const missing = await remoteMissingLocalTables(remote, localTables);
        if (missing.length > 0) {
          return true;
        }
        const drifted = await localRemoteSchemaDriftTables(
          remote,
          localDb,
          localTables,
        );
        return drifted.length > 0;
      } finally {
        localDb.close();
      }
    } finally {
      remote.close();
    }
  }

  async pushJob(
    jobId: string,
    credentials?: TursoCredentials,
    pushOptions?: PushJobOptions,
  ): Promise<PushResult> {
    const sources = await this.listLinkedSources();
    const linked = findLinkedSourceForJob(sources, jobId);
    if (!linked) {
      return { status: "skipped", tables: [], reason: "not_linked_to_app" };
    }
    const dbPath = linked.dbPath;
    if (!fs.existsSync(dbPath)) {
      return { status: "skipped", tables: [], reason: "local_db_missing" };
    }

    const syncKey = linkedSourceSyncKey(linked);
    const alternateKeys = linkedSourceAlternateKeys(linked);
    const databaseName = await this.resolveTursoDatabaseNameForLinked(linked);
    const creds = credentials ?? (await this.fetchCredentials(databaseName));

    const stateBeforePush = loadTursoSyncState();
    const localDirty = isJobDbDirty(syncKey, dbPath, stateBeforePush, alternateKeys);
    let dbBackup: LocalJobDbBackup | undefined;

    try {
      // When local has unpushed changes, local wins — never pull remote DELETEs
      // into the source-of-truth DB before pushing (failed push must be a no-op).
      if (!localDirty) {
        dbBackup = backupLocalJobDb(dbPath);
        await this.pullJob(syncKey, creds, {});
      } else {
        console.log(
          `[TursoSyncBridge] Skipping pre-push pull for ${syncKey} — local has unpushed changes`,
        );
      }

      const migrationRoot = resolveMigrationRootFromDbPath(dbPath);
      if (migrationRoot) {
        const migrationRemote = createRemoteClient(creds);
        try {
          const appliedMigrations = await applyPendingDatabaseMigrationsToTurso(
            migrationRemote,
            dbPath,
            migrationRoot,
          );
          if (appliedMigrations.length > 0) {
            console.log(
              `[TursoSyncBridge] Applied database migrations on Turso for ${syncKey}: ` +
                appliedMigrations.join(", "),
            );
          }
        } finally {
          migrationRemote.close();
        }
      }

      const stateAfterPull = loadTursoSyncState();
      const refreshedState = resolveTursoPushStateEntry(
        syncKey,
        dbPath,
        stateAfterPull,
        alternateKeys,
      );
      let result = await pushLocalDbToTurso(dbPath, creds, {
        jobId: syncKey,
        previousFingerprints: refreshedState?.tableFingerprints,
        lastPushedLogId: refreshedState?.lastPushedLogId,
        ...(pushOptions?.tableNames?.length
          ? { tableNames: pushOptions.tableNames }
          : {}),
        ...(pushOptions?.force ? { force: true } : {}),
      });

      if (localDbHasSyncableData(dbPath)) {
        const verifyRemote = createRemoteClient(creds);
        try {
          const stillEmpty = await remoteNeedsBootstrap(verifyRemote);
          if (stillEmpty) {
            console.warn(
              `[TursoSyncBridge] Remote empty after push for ${syncKey} — forcing bootstrap`,
            );
            result = await pushLocalDbToTurso(dbPath, creds, {
              jobId: syncKey,
              force: true,
              previousFingerprints: undefined,
              lastPushedLogId: 0,
              ...(pushOptions?.tableNames?.length
                ? { tableNames: pushOptions.tableNames }
                : {}),
            });
          } else {
            const localDb = openWritableLocalJobDb(dbPath);
            try {
              const localTables = filterSyncableTables(listUserTables(localDb));
              const driftCheckTables = pushOptions?.tableNames?.length
                ? localTables.filter((name) =>
                    pushOptions.tableNames!.includes(name),
                  )
                : localTables;
              const drifted = await localRemoteSchemaDriftTables(
                verifyRemote,
                localDb,
                driftCheckTables,
              );
              if (drifted.length > 0) {
                console.warn(
                  `[TursoSyncBridge] Remote schema drift for ${syncKey} on ` +
                    `${drifted.join(", ")} — applying incremental migration`,
                );
                for (const tableName of drifted) {
                  await migrateRemoteTableSchema(
                    verifyRemote,
                    localDb,
                    tableName,
                    async () => {
                      const table = readLocalTable(localDb, tableName);
                      await replaceRemoteTable(verifyRemote, table);
                    },
                  );
                  const columns = readTableSchema(localDb, tableName);
                  await ensureRemoteRowSyncColumns(verifyRemote, tableName);
                  await ensureRemoteTableSyncTriggers(verifyRemote, columns, tableName);
                }
                result = await pushLocalDbToTurso(dbPath, creds, {
                  jobId: syncKey,
                  previousFingerprints: refreshedState?.tableFingerprints,
                  lastPushedLogId: refreshedState?.lastPushedLogId,
                  ...(pushOptions?.tableNames?.length
                    ? { tableNames: pushOptions.tableNames }
                    : {}),
                });
              }
            } finally {
              localDb.close();
            }
          }
        } finally {
          verifyRemote.close();
        }
      }

      if (result.status === "pushed" && result.remoteVersion !== undefined) {
        recordTursoRemoteVersion(syncKey, dbPath, result.remoteVersion, undefined, {
          ...(result.lastPushedLogId !== undefined
            ? { lastPushedLogId: result.lastPushedLogId }
            : {}),
          ...(result.remoteLogMaxId !== undefined
            ? { lastPulledLogId: result.remoteLogMaxId }
            : {}),
        });
      }
      return result;
    } catch (error) {
      if (dbBackup) {
        try {
          restoreLocalJobDb(dbPath, dbBackup);
          console.warn(
            `[TursoSyncBridge] Restored local DB after failed push for ${syncKey}`,
          );
        } catch (restoreError) {
          console.error(
            `[TursoSyncBridge] Failed to restore local DB backup for ${syncKey}:`,
            (restoreError as Error).message,
          );
        }
      }
      throw error;
    } finally {
      if (dbBackup) {
        removeLocalJobDbBackup(dbBackup);
      }
    }
  }

  async pullJob(
    jobId: string,
    credentials?: TursoCredentials,
    pullOptions?: Omit<PullSourceSyncOptions, "jobId">,
  ): Promise<PullResult> {
    const sources = await this.listLinkedSources();
    const linked = findLinkedSourceForJob(sources, jobId);
    if (!linked) {
      return { status: "skipped", reason: "not_linked_to_app" };
    }
    const databaseName = await this.resolveTursoDatabaseNameForLinked(linked);
    const creds = credentials ?? (await this.fetchCredentials(databaseName));
    const state = loadTursoSyncState();
    const syncKey = linkedSourceSyncKey(linked);
    const alternateKeys = linkedSourceAlternateKeys(linked);
    const jobState = resolveTursoPushStateEntry(
      syncKey,
      linked.dbPath,
      state,
      alternateKeys,
    );
    const lastSeenRemoteVersion = jobState?.lastSeenRemoteVersion;
    const result = await pullTursoToLocalDb(linked.dbPath, creds, {
      jobId: syncKey,
      ...(lastSeenRemoteVersion !== undefined ? { lastSeenRemoteVersion } : {}),
      ...(jobState?.lastPulledLogId !== undefined
        ? { lastPulledLogId: jobState.lastPulledLogId }
        : {}),
      ...pullOptions,
    });
    if (result.remoteVersion !== undefined) {
      recordTursoRemoteVersion(syncKey, linked.dbPath, result.remoteVersion, undefined, {
        ...(result.lastPulledLogId !== undefined
          ? { lastPulledLogId: result.lastPulledLogId }
          : {}),
      });
    }
    if (result.status === "pulled") {
      const target: { jobId?: string; dbId?: string } = {};
      if (linked.jobId) {
        target.jobId = linked.jobId;
      }
      if (linked.dbId) {
        target.dbId = linked.dbId;
      }
      publishDbChanged(target);
    }
    return result;
  }

  /** @deprecated Use deleteJobTursoDatabase */
  async gcRemoteTablesForJob(jobId: string): Promise<string[]> {
    const deleted = await this.deleteJobTursoDatabase(jobId);
    return deleted ? ["database"] : [];
  }

  private logDatabaseLimitOnce(): void {
    if (this.databaseLimitLogged) {
      return;
    }
    this.databaseLimitLogged = true;
    console.warn(
      "[TursoSyncBridge] Turso org is at its database limit. " +
        "Delete unused per-job Turso databases or upgrade your Turso plan.",
    );
  }

  async pushDirtyLinkedSources(): Promise<SyncSummary> {
    return this.syncLinkedSources("push", { dirtyOnly: true });
  }

  /** Push Turso with explicit scope (app, alias, job, tables) instead of all dirty DBs. */
  async pushScoped(options: TursoPushScopedOptions = {}): Promise<TursoPushScopedResult> {
    const sources = await this.listLinkedSources();
    const tableNames = options.tables?.length ? options.tables : undefined;
    const explicitTargets = resolveLinkedSourcesForTursoPush(sources, options);
    const databases: TursoPushScopedDatabase[] = [];
    const summary: SyncSummary = {
      attempted: 0,
      pushed: 0,
      pulled: 0,
      skipped: 0,
      failed: 0,
      results: [],
    };

    type PushEntry = { source: TursoLinkedSource; syncKey: string };
    let entries: PushEntry[];

    if (explicitTargets.length > 0) {
      entries = explicitTargets.map((source) => ({
        source,
        syncKey: linkedSourceSyncKey(source),
      }));
    } else {
      const dirtyOnly = options.dirtyOnly !== false;
      const jobIds = await this.listJobIdsForTursoSync();
      entries = [];
      for (const syncKey of jobIds) {
        const linked = findLinkedSourceForJob(sources, syncKey);
        if (!linked) {
          continue;
        }
        if (dirtyOnly && !(await this.linkedSourceNeedsPush(linked))) {
          continue;
        }
        entries.push({ source: linked, syncKey });
      }
    }

    for (const { source, syncKey } of entries) {
      databases.push({
        syncKey,
        tursoDatabase: resolveTursoDatabaseLabel(source),
        alias: source.alias,
        appId: source.appId,
        ...(tableNames ? { tables: [...tableNames] } : {}),
      });

      summary.attempted += 1;
      const result: JobSyncResult = { jobId: syncKey };
      try {
        const pushResult = await this.pushJob(syncKey, undefined, { tableNames });
        result.push = pushResult;
        if (pushResult.status === "pushed") {
          summary.pushed += 1;
          const linked = findLinkedSourceForJob(await this.listLinkedSources(), syncKey);
          if (linked) {
            const { recordTursoPushSuccess } = await import("./tursoSyncState.js");
            recordTursoPushSuccess(
              linkedSourceSyncKey(linked),
              linked.dbPath,
              undefined,
              pushResult.tableFingerprints,
              pushResult.lastPushedLogId,
            );
          }
        } else if (
          pushResult.reason === "all_tables_unchanged" &&
          pushResult.tableFingerprints
        ) {
          summary.skipped += 1;
          const linked = findLinkedSourceForJob(await this.listLinkedSources(), syncKey);
          if (linked) {
            const { recordTursoPushSuccess } = await import("./tursoSyncState.js");
            recordTursoPushSuccess(
              linkedSourceSyncKey(linked),
              linked.dbPath,
              undefined,
              pushResult.tableFingerprints,
              pushResult.lastPushedLogId,
            );
          }
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        const message = (error as Error).message;
        summary.failed += 1;
        result.error = message;
        console.warn(
          `[TursoSyncBridge] scoped push failed for ${syncKey}:`,
          message.slice(0, 120),
        );
      }
      summary.results.push(result);
    }

    if (summary.attempted > 0) {
      console.log(
        `[TursoSyncBridge] scoped push complete: ` +
          `databases=${databases.map((db) => db.tursoDatabase).join(", ") || "none"} ` +
          `pushed=${summary.pushed} skipped=${summary.skipped} failed=${summary.failed}`,
      );
    }

    return { ...summary, databases };
  }

  /** Push every Turso-linked database for one mini-app (Upload now). */
  async pushAppLinkedSources(appId: string): Promise<SyncSummary> {
    return this.syncLinkedSources("push", { appId });
  }

  async pullLinkedSourcesIfNeeded(): Promise<SyncSummary> {
    return this.syncLinkedSources("pull", {
      pullOptions: {
        onlyIfLocalEmpty: true,
        skipIfLocalDirty: true,
      },
    });
  }

  async pushAllLinkedSources(): Promise<SyncSummary> {
    return this.syncLinkedSources("push");
  }

  async pullAllLinkedSources(): Promise<SyncSummary> {
    // No onlyIfLocalEmpty/skipIfLocalDirty guards (we want cloud changes even
    // when local has data), but NOT force either: force does a full-table
    // replace that clobbers local unpushed rows. Without force the pull
    // delta-merges from the remote changelog and only falls back to a full
    // read when the remote has no changelog.
    return this.syncLinkedSources("pull", { pullOptions: {} });
  }

  /** @deprecated Use pushAllLinkedSources */
  async pushAllJobs(): Promise<SyncSummary> {
    return this.pushAllLinkedSources();
  }

  /** @deprecated Use pullAllLinkedSources */
  async pullAllJobs(): Promise<SyncSummary> {
    return this.pullAllLinkedSources();
  }

  private async syncLinkedSources(
    mode: "push" | "pull",
    options?: {
      dirtyOnly?: boolean;
      appId?: string;
      forcePull?: boolean;
      pullOptions?: Omit<PullSourceSyncOptions, "jobId">;
    },
  ): Promise<SyncSummary> {
    const summary: SyncSummary = {
      attempted: 0,
      pushed: 0,
      pulled: 0,
      skipped: 0,
      failed: 0,
      results: [],
    };

    if (!this.enabled) {
      return summary;
    }

    let apiKey: string | undefined;
    try {
      apiKey = (await getPaprApiKey()) ?? undefined;
    } catch {
      return summary;
    }
    if (!apiKey) {
      return summary;
    }

    const jobIds = await this.listJobIdsForTursoSync();
    const linkedSources = await this.listLinkedSources();
    const appJobIds =
      options?.appId === undefined
        ? null
        : new Set(
            linkedSources
              .filter((source) => source.appId === options.appId)
              .map((source) => linkedSourceSyncKey(source)),
          );

    for (const jobId of jobIds) {
      if (appJobIds && !appJobIds.has(jobId)) {
        continue;
      }
      if (mode === "push" && options?.dirtyOnly) {
        const linked = findLinkedSourceForJob(linkedSources, jobId);
        if (!linked) {
          continue;
        }
        if (!(await this.linkedSourceNeedsPush(linked))) {
          continue;
        }
      }

      summary.attempted += 1;
      const result: JobSyncResult = { jobId };
      try {
        if (mode === "push") {
          const pushResult = await this.pushJob(jobId);
          result.push = pushResult;
          if (pushResult.status === "pushed") {
            summary.pushed += 1;
            const linked = findLinkedSourceForJob(
              await this.listLinkedSources(),
              jobId,
            );
            if (linked) {
              const { recordTursoPushSuccess } = await import("./tursoSyncState.js");
              recordTursoPushSuccess(
                linkedSourceSyncKey(linked),
                linked.dbPath,
                undefined,
                pushResult.tableFingerprints,
                pushResult.lastPushedLogId,
              );
            }
          } else if (
            pushResult.reason === "all_tables_unchanged" &&
            pushResult.tableFingerprints
          ) {
            summary.skipped += 1;
            const linked = findLinkedSourceForJob(
              await this.listLinkedSources(),
              jobId,
            );
            if (linked) {
              const { recordTursoPushSuccess } = await import("./tursoSyncState.js");
              recordTursoPushSuccess(
                linkedSourceSyncKey(linked),
                linked.dbPath,
                undefined,
                pushResult.tableFingerprints,
                pushResult.lastPushedLogId,
              );
            }
          } else {
            summary.skipped += 1;
          }
        } else {
          const pullResult = await this.pullJob(
            jobId,
            undefined,
            options?.forcePull
              ? { force: true }
              : options?.pullOptions,
          );
          result.pull = pullResult;
          if (pullResult.status === "pulled") {
            summary.pulled += 1;
          } else {
            summary.skipped += 1;
          }
        }
      } catch (error) {
        const message = (error as Error).message;
        summary.failed += 1;
        result.error = message;
        if (isTursoDatabaseLimitError(message)) {
          break;
        }
        if (isTursoProvisioningRateLimitError(message)) {
          this.invalidateCredentialsCache();
          break;
        }
        if (
          isTursoLocalDatabaseCorruptError(message) ||
          isTursoSqliteBindTypeError(message)
        ) {
          const linked = findLinkedSourceForJob(
            await this.listLinkedSources(),
            jobId,
          );
          if (linked) {
            recordTursoPushQuarantine(jobId, linked.dbPath, message);
          }
          continue;
        }
        console.warn(
          `[TursoSyncBridge] ${mode} failed for linked job ${jobId}:`,
          message.slice(0, 120),
        );
      }
      summary.results.push(result);
    }

    if (summary.pushed > 0 || summary.pulled > 0) {
      console.log(
        `[TursoSyncBridge] ${mode} complete (app-linked only): ` +
          `pushed=${summary.pushed} pulled=${summary.pulled} ` +
          `skipped=${summary.skipped} failed=${summary.failed}`,
      );
    }

    return summary;
  }
}

let instance: TursoSyncBridge | null = null;

export function initializeTursoSyncBridge(options?: {
  jobsRootDir?: string;
  appsRootDir?: string;
  memoryServerBase?: string;
}): TursoSyncBridge {
  instance = new TursoSyncBridge(options);
  return instance;
}

export function getTursoSyncBridge(): TursoSyncBridge | null {
  return instance;
}

export async function syncTursoBeforeCloudRun(): Promise<void> {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }
  try {
    await bridge.pushDirtyLinkedSources();
  } catch (error) {
    console.warn(
      "[TursoSyncBridge] Pre-cloud push failed:",
      (error as Error).message.slice(0, 120),
    );
  }
}

/** Pull Turso into local SQLite after cloud job runs (desktop wake). Default on; set false to disable. */
export function shouldPullTursoAfterCloudRun(): boolean {
  const raw = process.env.TURSO_PULL_AFTER_CLOUD_RUN?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no") {
    return false;
  }
  return true;
}

async function pullAllLinkedSourcesQuiet(logLabel: string): Promise<void> {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }
  try {
    const summary = await bridge.pullAllLinkedSources();
    if (summary.pulled > 0) {
      console.log(
        `[TursoSyncBridge] ${logLabel}: pulled ${summary.pulled} linked DB(s)`,
      );
    }
  } catch (error) {
    console.warn(
      `[TursoSyncBridge] ${logLabel} failed:`,
      (error as Error).message.slice(0, 120),
    );
  }
}

/** Merge remote Turso changes into local SQLite after git pull (workspace updates). */
export async function syncTursoAfterGitPull(): Promise<void> {
  await pullAllLinkedSourcesQuiet("Post-git-pull Turso pull");
}

export async function syncTursoAfterCloudRun(): Promise<void> {
  if (!shouldPullTursoAfterCloudRun()) {
    return;
  }
  await pullAllLinkedSourcesQuiet("Post-cloud-run Turso pull");
}
