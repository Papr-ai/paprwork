/**
 * TursoSyncBridge — boundary push/pull for app-linked job data ↔ Turso.
 *
 * One Turso DB per linked job (j-{jobId8}). Only SQLite sources registered in app
 * data-sources.json sync (primary/readonly). Scratch tables stay local.
 */

import * as fs from "fs";
import * as path from "path";
import { getPaprApiKey } from "../utils/keyResolver.js";
import { publishDbChanged } from "../utils/publishJobRunEvents.js";
import {
  getPaprAppsRoot,
  getPaprJobsRoot,
} from "../../core/utils/paprRoot.js";
import {
  discoverTursoLinkedSources,
  findLinkedSourceForJob,
  listLinkedJobIdsForTursoSync,
  type TursoLinkedSource,
} from "./tursoLinkedSources.js";
import { jobTursoDatabaseName } from "./tursoDatabaseNaming.js";
import {
  createRemoteClient,
  isTursoDatabaseLimitError,
  isTursoProvisioningRateLimitError,
  pullTursoToLocalDb,
  pushLocalDbToTurso,
  remoteAheadOfLocal,
  type PullResult,
  type PullSourceSyncOptions,
  type PushResult,
  type TursoCredentials,
} from "./tursoSyncBridgeCore.js";
import { remoteSyncLogExists } from "./tursoSyncLog.js";
import {
  isJobDbDirty,
  loadTursoSyncState,
  recordTursoRemoteVersion,
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
        body: JSON.stringify({ database: databaseName }),
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
          body: JSON.stringify({ database: databaseName }),
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

  async pushJob(
    jobId: string,
    credentials?: TursoCredentials,
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

    const state = loadTursoSyncState();
    const jobState = state.jobs[jobId];
    const databaseName = await this.resolveTursoDatabaseNameForLinked(linked);
    const creds = credentials ?? (await this.fetchCredentials(databaseName));

    const remote = createRemoteClient(creds);
    try {
      const remoteAhead = await remoteAheadOfLocal(remote, {
        lastSeenRemoteVersion: jobState?.lastSeenRemoteVersion,
        lastPulledLogId: jobState?.lastPulledLogId,
      });
      if (remoteAhead) {
        // Prefer delta merge from the remote changelog so unpushed local rows
        // survive. A force (full-table replace) pull would clobber local dirty
        // state — only fall back to it when the remote has no changelog to
        // merge from (legacy pre-CDC databases).
        const hasRemoteLog = await remoteSyncLogExists(remote);
        if (!hasRemoteLog) {
          console.warn(
            `[TursoSyncBridge] Remote ahead for ${jobId} with no changelog — ` +
              `full pull fallback (local unpushed rows may be replaced)`,
          );
        }
        await this.pullJob(jobId, creds, hasRemoteLog ? {} : { force: true });
      }
    } finally {
      remote.close();
    }

    const stateAfterPull = loadTursoSyncState();
    const refreshedState = stateAfterPull.jobs[jobId];
    const result = await pushLocalDbToTurso(dbPath, creds, {
      jobId,
      previousFingerprints: refreshedState?.tableFingerprints,
      lastPushedLogId: refreshedState?.lastPushedLogId,
    });
    if (result.status === "pushed" && result.remoteVersion !== undefined) {
      recordTursoRemoteVersion(jobId, dbPath, result.remoteVersion, undefined, {
        ...(result.lastPushedLogId !== undefined
          ? { lastPushedLogId: result.lastPushedLogId }
          : {}),
        // Advance lastPulledLogId past our own mirrored entries so the next
        // push doesn't see them as "remote ahead" (self-echo → forced pull).
        ...(result.remoteLogMaxId !== undefined
          ? { lastPulledLogId: result.remoteLogMaxId }
          : {}),
      });
    }
    return result;
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
    const jobState = state.jobs[jobId];
    const lastSeenRemoteVersion = jobState?.lastSeenRemoteVersion;
    const result = await pullTursoToLocalDb(linked.dbPath, creds, {
      jobId,
      ...(lastSeenRemoteVersion !== undefined ? { lastSeenRemoteVersion } : {}),
      ...(jobState?.lastPulledLogId !== undefined
        ? { lastPulledLogId: jobState.lastPulledLogId }
        : {}),
      ...pullOptions,
    });
    if (result.remoteVersion !== undefined) {
      recordTursoRemoteVersion(jobId, linked.dbPath, result.remoteVersion, undefined, {
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
    const state = loadTursoSyncState();

    for (const jobId of jobIds) {
      if (mode === "push" && options?.dirtyOnly) {
        const linked = (await this.listLinkedSources()).find(
          (source) => source.jobId === jobId,
        );
        if (!linked || !isJobDbDirty(jobId, linked.dbPath, state)) {
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
                jobId,
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
                jobId,
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

export async function syncTursoAfterCloudRun(): Promise<void> {
  if (!shouldPullTursoAfterCloudRun()) {
    return;
  }
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }
  try {
    await bridge.pullAllLinkedSources();
  } catch (error) {
    console.warn(
      "[TursoSyncBridge] Post-cloud pull failed:",
      (error as Error).message.slice(0, 120),
    );
  }
}
