/**
 * TursoSyncBridge — boundary push/pull for app-linked job data ↔ Turso.
 *
 * One Turso DB per linked job (j-{jobId8}). Only SQLite sources registered in app
 * data-sources.json sync (primary/readonly). Scratch tables stay local.
 */

import * as fs from "fs";
import * as path from "path";
import { mergeCloudActingUserBody } from "../utils/cloudActingUser.js";
import {
  canPerformWorkspaceDbWrite,
  getWorkspaceWriteGeneration,
} from "./workspaceWriteGuard.js";
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
  linkedSourceAsAppDataSource,
  linkedSourceSyncKey,
  listLinkedJobIdsForTursoSync,
  resolveLinkedSourcesForTursoPush,
  resolveTursoDatabaseLabel,
  type TursoLinkedSource,
} from "./tursoLinkedSources.js";
import { jobTursoDatabaseName } from "./tursoDatabaseNaming.js";
import {
  createRemoteClient,
  filterSyncableTables,
  isTursoDatabaseLimitError,
  isTursoLocalDatabaseCorruptError,
  isTursoProvisioningRateLimitError,
  isTursoSqliteBindTypeError,
  listUserTables,
  openWritableLocalJobDb,
  type PullResult,
  type PullSourceSyncOptions,
  type PushResult,
  type TursoCredentials,
} from "./tursoSyncBridgeCore.js";
import {
  clearTursoCredentialsStore,
  getTursoCredentialsEntry,
  removeTursoCredentialsEntry,
  saveTursoCredentialsEntry,
  tursoCredentialsFromRecord,
} from "./tursoCredentialsStore.js";
import { recordTursoPushQuarantine } from "./tursoSyncState.js";
import {
  localRemoteSchemaDriftTables,
  remoteMissingLocalTables,
  remoteNeedsBootstrap,
} from "./tursoDeltaSync.js";
import {
  clearStaleDirtyFlagIfClean,
  isJobDbDirty,
  isLinkedSourceDirtyFast,
  loadTursoSyncState,
  localDbHasSyncableData,
} from "./tursoSyncState.js";
import {
  reconcileLinkedSourcesFromCloud,
  reconcileFromCloudDbChanges,
  reconcileFromSyncIndex,
  type CloudTursoDbChange,
  type TursoCloudSyncScope,
  type TursoCloudSyncSessionResult,
  type TursoCloudSyncTrigger,
} from "./tursoSyncSession.js";

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
  expiresAt?: string;
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
  readonly enabled: boolean;
  private databaseLimitLogged = false;
  private linkedSourcesCache: TursoLinkedSource[] | null = null;
  private credentialsCacheByDb = new Map<string, CachedCredentials>();
  private credentialsFetchPromises = new Map<string, Promise<TursoCredentials>>();
  /** Serialize Turso remote ops per on-disk dbPath — avoids "Client was closed" races. */
  private dbPathOperationChains = new Map<string, Promise<unknown>>();

  private static normalizeDbPathLockKey(dbPath: string): string {
    return path.normalize(dbPath);
  }

  /** Run one async Turso remote session at a time per SQLite file. */
  async runExclusiveForDbPath<T>(
    dbPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = TursoSyncBridge.normalizeDbPathLockKey(dbPath);
    const prior = this.dbPathOperationChains.get(key);
    const run = (prior ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => operation());
    this.dbPathOperationChains.set(key, run);
    try {
      return await run;
    } finally {
      if (this.dbPathOperationChains.get(key) === run) {
        this.dbPathOperationChains.delete(key);
      }
    }
  }

  /** @deprecated Prefer runExclusiveForDbPath — resolves syncKey to dbPath. */
  async runExclusiveForSyncKey<T>(
    syncKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const sources = await this.listLinkedSources();
    const linked = findLinkedSourceForJob(sources, syncKey);
    if (linked) {
      return this.runExclusiveForDbPath(linked.dbPath, operation);
    }
    return operation();
  }

  /** Fallback cache TTL when memory server omits expiresAt. */
  private static readonly CREDENTIALS_TTL_MS = 50 * 60_000;
  private static readonly CREDENTIALS_EXPIRY_SAFETY_MS = 60_000;

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

  async resolveTursoDatabaseNameForLinked(
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

    const persisted = getTursoCredentialsEntry(databaseName);
    if (persisted && persisted.expiresAtMs > now) {
      this.rememberCredentials(databaseName, tursoCredentialsFromRecord(persisted), persisted.expiresAtMs);
      return tursoCredentialsFromRecord(persisted);
    }

    const inFlight = this.credentialsFetchPromises.get(databaseName);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.fetchCredentialsUncached(databaseName)
      .then((bundle) => {
        this.rememberCredentials(databaseName, bundle.creds, bundle.expiresAtMs);
        this.credentialsFetchPromises.delete(databaseName);
        return bundle.creds;
      })
      .catch((error) => {
        this.credentialsFetchPromises.delete(databaseName);
        if (persisted) {
          console.warn(
            `[TursoSyncBridge] Token refresh failed for ${databaseName} — using persisted credentials (${(error as Error).message.slice(0, 80)})`,
          );
          this.rememberCredentials(
            databaseName,
            tursoCredentialsFromRecord(persisted),
            persisted.expiresAtMs,
          );
          return tursoCredentialsFromRecord(persisted);
        }
        throw error;
      });

    this.credentialsFetchPromises.set(databaseName, promise);
    return promise;
  }

  /**
   * Offline-first credentials for opening a local Turso replica file.
   * Uses persisted credentials when the network or token refresh is unavailable.
   */
  async resolveCredentialsForReplicaOpen(
    databaseName: string,
    options: { localReplicaExists: boolean },
  ): Promise<TursoCredentials> {
    const now = Date.now();
    const cached = this.credentialsCacheByDb.get(databaseName);
    if (cached && cached.expiresAt > now) {
      return cached.creds;
    }

    const persisted = getTursoCredentialsEntry(databaseName);
    if (persisted && persisted.expiresAtMs > now) {
      this.rememberCredentials(databaseName, tursoCredentialsFromRecord(persisted), persisted.expiresAtMs);
      return tursoCredentialsFromRecord(persisted);
    }

    try {
      return await this.fetchCredentials(databaseName);
    } catch (error) {
      if (options.localReplicaExists && persisted) {
        console.warn(
          `[TursoSyncBridge] Opening local replica for ${databaseName} with persisted credentials (offline or refresh failed)`,
        );
        this.rememberCredentials(
          databaseName,
          tursoCredentialsFromRecord(persisted),
          persisted.expiresAtMs,
        );
        return tursoCredentialsFromRecord(persisted);
      }
      throw error;
    }
  }

  invalidateCredentialsCache(databaseName?: string): void {
    if (databaseName) {
      this.credentialsCacheByDb.delete(databaseName);
      this.credentialsFetchPromises.delete(databaseName);
      removeTursoCredentialsEntry(databaseName);
      return;
    }
    this.credentialsCacheByDb.clear();
    this.credentialsFetchPromises.clear();
    clearTursoCredentialsStore();
  }

  private rememberCredentials(
    databaseName: string,
    creds: TursoCredentials,
    expiresAtMs: number,
  ): void {
    this.credentialsCacheByDb.set(databaseName, { creds, expiresAt: expiresAtMs });
    saveTursoCredentialsEntry(databaseName, creds, expiresAtMs);
  }

  private resolveCredentialExpiryMs(expiresAt?: string): number {
    const now = Date.now();
    if (expiresAt) {
      return Math.max(
        now + TursoSyncBridge.CREDENTIALS_EXPIRY_SAFETY_MS,
        new Date(expiresAt).getTime() - TursoSyncBridge.CREDENTIALS_EXPIRY_SAFETY_MS,
      );
    }
    return now + TursoSyncBridge.CREDENTIALS_TTL_MS;
  }

  private async fetchCredentialsUncached(
    databaseName: string,
  ): Promise<{ creds: TursoCredentials; expiresAtMs: number }> {
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
    const creds: TursoCredentials = {
      tursoUrl: data.tursoUrl,
      authToken: data.authToken,
    };
    return {
      creds,
      expiresAtMs: this.resolveCredentialExpiryMs(data.expiresAt),
    };
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

  /**
   * Remote Turso comparison for needs-push (caller must hold dbPath lock when
   * concurrent pushes or status polls could overlap).
   */
  private async linkedSourceNeedsPushRemoteCheck(
    linked: TursoLinkedSource,
  ): Promise<boolean> {
    const appSource = linkedSourceAsAppDataSource(linked);
    const { shouldUseTursoReplicaForSource, syncStatusForLinkedDb } =
      await import("./tursoReplica/tursoReplicaRouting.js");
    if (shouldUseTursoReplicaForSource(appSource)) {
      const status = await syncStatusForLinkedDb(appSource);
      return status.pendingPush;
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

  /** Needs-push evaluation without acquiring dbPath lock (for nested scheduler calls). */
  private async evaluateLinkedSourceNeedsPush(
    linked: TursoLinkedSource,
  ): Promise<boolean> {
    const appSource = linkedSourceAsAppDataSource(linked);
    const { shouldUseTursoReplicaForSource, syncStatusForLinkedDb } =
      await import("./tursoReplica/tursoReplicaRouting.js");
    if (shouldUseTursoReplicaForSource(appSource)) {
      try {
        const status = await syncStatusForLinkedDb(appSource);
        return (
          status.pendingPush ||
          status.migrationConflict ||
          status.cutoverBlocked
        );
      } catch {
        return true;
      }
    }

    const syncKey = linkedSourceSyncKey(linked);
    const alternateKeys = linkedSourceAlternateKeys(linked);
    clearStaleDirtyFlagIfClean(
      syncKey,
      linked.dbPath,
      undefined,
      alternateKeys,
    );
    const state = loadTursoSyncState();
    const fast = isLinkedSourceDirtyFast(
      syncKey,
      linked.dbPath,
      state,
      alternateKeys,
    );
    if (fast === false) {
      return false;
    }
    if (fast !== true && isJobDbDirty(syncKey, linked.dbPath, state, alternateKeys)) {
      return true;
    }
    if (fast === true) {
      return true;
    }
    if (!localDbHasSyncableData(linked.dbPath)) {
      return false;
    }
    return this.linkedSourceNeedsPushRemoteCheck(linked);
  }

  /** True when dirty fast-path, fingerprints, or remote lacks local tables. */
  async linkedSourceNeedsPush(linked: TursoLinkedSource): Promise<boolean> {
    return this.runExclusiveForDbPath(linked.dbPath, () =>
      this.evaluateLinkedSourceNeedsPush(linked),
    );
  }

  /**
   * Scheduler / flush path: needs-push check + push under one dbPath lock so
   * no other remote client opens/closes between the two steps.
   */
  async pushLinkedSourceIfNeeded(
    linked: TursoLinkedSource,
    pushOptions?: PushJobOptions,
  ): Promise<PushResult | null> {
    return this.runExclusiveForDbPath(linked.dbPath, async () => {
      if (!(await this.evaluateLinkedSourceNeedsPush(linked))) {
        return null;
      }
      return this.pushJobUnlocked(linked, undefined, pushOptions);
    });
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

    return this.runExclusiveForDbPath(linked.dbPath, () =>
      this.pushJobUnlocked(linked, credentials, pushOptions),
    );
  }

  private async pushJobUnlocked(
    linked: TursoLinkedSource,
    credentials?: TursoCredentials,
    pushOptions?: PushJobOptions,
  ): Promise<PushResult> {
    const dbPath = linked.dbPath;
    const syncKey = linkedSourceSyncKey(linked);
    const writeGeneration = getWorkspaceWriteGeneration();
    if (
      !canPerformWorkspaceDbWrite(
        writeGeneration,
        dbPath,
        `turso bridge push ${syncKey}`,
      )
    ) {
      return { status: "skipped", tables: [], reason: "workspace_switch" };
    }
    const databaseName = await this.resolveTursoDatabaseNameForLinked(linked);
    const creds = credentials ?? (await this.fetchCredentials(databaseName));

    const appSource = linkedSourceAsAppDataSource(linked);
    const { shouldUseTursoReplicaForSource, pushLinkedDbViaTursoReplica } =
      await import("./tursoReplica/tursoReplicaRouting.js");
    if (shouldUseTursoReplicaForSource(appSource)) {
      const result = await pushLinkedDbViaTursoReplica(appSource);
      if (result.ok) {
        return { status: "pushed", tables: [], syncMode: "replica" };
      }
      return {
        status: "failed",
        tables: [],
        error: result.error ?? "Turso replica push failed",
        syncMode: "replica",
      };
    }

    const { pushLinkedSourceViaWorkspaceLog } = await import(
      "./syncV3/workspaceLogSync.js"
    );
    return pushLinkedSourceViaWorkspaceLog(linked, creds, pushOptions);
  }


  async pullJob(
    jobId: string,
    _credentials?: TursoCredentials,
    pullOptions?: Omit<PullSourceSyncOptions, "jobId">,
  ): Promise<PullResult> {
    const sources = await this.listLinkedSources();
    const linked = findLinkedSourceForJob(sources, jobId);
    if (!linked) {
      return { status: "skipped", reason: "not_linked_to_app" };
    }

    const appSource = linkedSourceAsAppDataSource(linked);
    const { shouldUseTursoReplicaForSource, pullLinkedDbViaTursoReplica } =
      await import("./tursoReplica/tursoReplicaRouting.js");
    if (shouldUseTursoReplicaForSource(appSource)) {
      try {
        const pulled = await pullLinkedDbViaTursoReplica(appSource, {
          forceReconnect: pullOptions?.forceReconnect === true,
        });
        if (pulled) {
          return { status: "pulled", syncMode: "replica" };
        }
        return { status: "skipped", reason: "remote_unchanged", syncMode: "replica" };
      } catch (error) {
        return {
          status: "failed",
          error: (error as Error).message,
          syncMode: "replica",
        };
      }
    }

    const { pullLinkedSourceViaWorkspaceLog } = await import(
      "./syncV3/workspaceLogSync.js"
    );
    let result = await pullLinkedSourceViaWorkspaceLog(linked);

    if (result.status !== "pulled") {
      const databaseName = await this.resolveTursoDatabaseNameForLinked(linked);
      const creds =
        _credentials ?? (await this.fetchCredentials(databaseName));
      const { pullLinkedSourceViaTursoRemoteCdc } = await import(
        "./tursoRemoteCdcPull.js"
      );
      const cdcResult = await this.runExclusiveForDbPath(linked.dbPath, () =>
        pullLinkedSourceViaTursoRemoteCdc(linked, creds),
      );
      if (cdcResult.status === "pulled") {
        result = cdcResult;
      }
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
              pushResult.lastPushedLogId,
            );
          }
        } else if (
          pushResult.reason === "all_tables_unchanged" &&
          pushResult.lastPushedLogId !== undefined
        ) {
          summary.skipped += 1;
          const linked = findLinkedSourceForJob(await this.listLinkedSources(), syncKey);
          if (linked) {
            const { recordTursoPushSuccess } = await import("./tursoSyncState.js");
            recordTursoPushSuccess(
              linkedSourceSyncKey(linked),
              linked.dbPath,
              undefined,
              pushResult.lastPushedLogId,
            );
          }
        } else if (pushResult.status === "failed") {
          // Counting a failed push as "skipped" hid real sync failures
          // behind a clean-looking summary.
          summary.failed += 1;
          if (pushResult.error) {
            result.error = pushResult.error;
          }
          console.warn(
            `[TursoSyncBridge] scoped push failed for ${syncKey}:`,
            (pushResult.error ?? "").slice(0, 120),
          );
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
  async pushAppLinkedSources(
    appId: string,
    options?: { force?: boolean },
  ): Promise<SyncSummary> {
    return this.syncLinkedSources("push", {
      appId,
      forcePush: options?.force === true,
    });
  }

  /** Pull Turso into local SQLite for one mini-app (post-install bootstrap). */
  async pullAppLinkedSources(
    appId: string,
    options?: { force?: boolean },
  ): Promise<SyncSummary> {
    if (options?.force === true) {
      return this.syncLinkedSources("pull", {
        appId,
        forcePull: true,
        pullOptions: {},
      });
    }
    return this.reconcileFromCloud(
      { appId },
      { assumeRemoteChanged: true, trigger: "manual" },
    );
  }

  /**
   * Event-driven cloud→local sync: scoped, cheap remote-ahead check, push-if-dirty.
   */
  async reconcileFromCloud(
    scope?: TursoCloudSyncScope,
    options?: {
      assumeRemoteChanged?: boolean;
      trigger?: TursoCloudSyncTrigger;
      preferRemote?: boolean;
    },
  ): Promise<SyncSummary> {
    const sessions = await reconcileLinkedSourcesFromCloud(
      this,
      scope,
      options,
    );
    return sessionResultsToSyncSummary(sessions);
  }

  /** Hydrate local SQLite from cloud Turso db-changed notifications. */
  async reconcileFromCloudDbChanges(
    changes: readonly CloudTursoDbChange[],
    options?: {
      jobWriteDbIds?: ReadonlyMap<string, readonly string[]>;
    },
  ): Promise<SyncSummary> {
    const sessions = await reconcileFromCloudDbChanges(this, changes, {
      trigger: "cloud_db_changed",
      ...(options?.jobWriteDbIds ? { jobWriteDbIds: options.jobWriteDbIds } : {}),
    });
    return sessionResultsToSyncSummary(sessions);
  }

  /** Poll workspace sync-index for linked sources that advanced remotely. */
  async reconcileFromSyncIndex(options?: {
    trigger?: TursoCloudSyncTrigger;
  }): Promise<SyncSummary> {
    const sessions = await reconcileFromSyncIndex(this, {
      trigger: options?.trigger ?? "sync_index",
    });
    return sessionResultsToSyncSummary(sessions);
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
    // Scoped session sync: skip when remote unchanged; push-then-pull when local dirty.
    return this.reconcileFromCloud(undefined, { trigger: "periodic" });
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
      forcePush?: boolean;
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
          const pushResult = await this.pushJob(
            jobId,
            undefined,
            options?.forcePush ? { force: true } : undefined,
          );
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
                pushResult.lastPushedLogId,
              );
            }
          } else if (
            pushResult.reason === "all_tables_unchanged" &&
            pushResult.lastPushedLogId !== undefined
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
                pushResult.lastPushedLogId,
              );
            }
          } else if (pushResult.status === "failed") {
            // A failed push counted as "skipped" made the sync panel look
            // calm while nothing reached the cloud. Report it as failed.
            summary.failed += 1;
            if (pushResult.error) {
              result.error = pushResult.error;
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

/** Initialize Turso bridge immediately (install/bootstrap must not wait for startup delay). */
export function ensureTursoSyncBridge(options?: {
  jobsRootDir?: string;
  appsRootDir?: string;
  memoryServerBase?: string;
}): TursoSyncBridge {
  return getTursoSyncBridge() ?? initializeTursoSyncBridge(options);
}

/** Pull linked DBs for one app after cloud install or track sync. */
export async function syncTursoAfterAppInstall(appId: string): Promise<SyncSummary> {
  const bridge = ensureTursoSyncBridge();
  return bridge.pullAppLinkedSources(appId);
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

export interface SyncTursoFromCloudDbChangedOptions {
  jobWriteDbIds?: ReadonlyMap<string, readonly string[]>;
}

/** Desktop handler for cloud Turso db-changed (direct test invoke). */
export async function syncTursoFromCloudDbChanged(
  changes: readonly CloudTursoDbChange[],
  options?: SyncTursoFromCloudDbChangedOptions,
): Promise<SyncSummary> {
  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled || changes.length === 0) {
    return {
      attempted: 0,
      pushed: 0,
      pulled: 0,
      skipped: 0,
      failed: 0,
      results: [],
    };
  }
  return bridge.reconcileFromCloudDbChanges(changes, options);
}

/** Desktop handler for sync-index heartbeat poll. */
export async function syncTursoFromSyncIndex(): Promise<SyncSummary> {
  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled) {
    return {
      attempted: 0,
      pushed: 0,
      pulled: 0,
      skipped: 0,
      failed: 0,
      results: [],
    };
  }
  return bridge.reconcileFromSyncIndex({ trigger: "heartbeat" });
}

function sessionResultsToSyncSummary(
  sessions: TursoCloudSyncSessionResult[],
): SyncSummary {
  const summary: SyncSummary = {
    attempted: sessions.length,
    pushed: 0,
    pulled: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (const session of sessions) {
    const result: JobSyncResult = { jobId: session.syncKey };
    if (session.push) {
      result.push = session.push;
    }
    if (session.pull) {
      result.pull = session.pull;
    }
    if (session.error) {
      result.error = session.error;
    }
    summary.results.push(result);

    switch (session.action) {
      case "failed":
        summary.failed += 1;
        break;
      case "pulled":
      case "pushed_then_pulled":
        summary.pulled += 1;
        if (session.action === "pushed_then_pulled") {
          summary.pushed += 1;
        }
        break;
      case "pushed":
        summary.pushed += 1;
        break;
      default:
        summary.skipped += 1;
    }
  }

  return summary;
}

/** Materialize workspace log into local SQLite after git pull or startup. */
export async function syncTursoAfterGitPull(): Promise<void> {
  const { catchUpAllLinkedSourcesFromWorkspaceLog } = await import(
    "./syncV3/workspaceLogSync.js"
  );
  const appsRoot = getPaprAppsRoot();
  const applied = await catchUpAllLinkedSourcesFromWorkspaceLog(appsRoot);
  if (applied > 0) {
    console.log(
      `[TursoSyncBridge] Materialized ${applied} workspace log entry(ies) after sync`,
    );
  }
}
