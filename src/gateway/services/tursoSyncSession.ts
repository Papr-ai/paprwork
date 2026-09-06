/**
 * Cloud → local Turso sync sessions (platform-wide).
 *
 * Best practice: event-triggered, scoped pulls with a cheap remote-ahead check.
 * - Local dirty → push (pushJob runs merge pull-then-push for bidirectional sources)
 * - Local clean + remote ahead → pull only
 * - Otherwise → skip (no blind pullAll)
 */

import type { PullResult, PushResult } from "./tursoSyncBridgeCore.js";
import {
  findLinkedSourceForJob,
  linkedSourceAlternateKeys,
  linkedSourceAsAppDataSource,
  linkedSourceSyncKey,
  resolveLinkedSourcesForTursoPush,
  type TursoLinkedSource,
} from "./tursoLinkedSources.js";
import {
  shouldUseTursoReplicaForSource,
  syncStatusForLinkedDb,
} from "./tursoReplica/tursoReplicaRouting.js";
import {
  isJobDbDirty,
  loadTursoSyncState,
  resolveTursoPushStateEntry,
  recordTursoIndexVersion,
} from "./tursoSyncState.js";
import { listDbDirtySyncKeysForApp } from "./tursoSyncState.js";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import {
  loadSyncIndexSnapshot,
} from "./tursoSyncIndex.js";
import {
  createRemoteClient,
  remoteAheadOfLocal,
} from "./tursoSyncBridgeCore.js";

export type TursoCloudSyncTrigger =
  | "app_open"
  | "post_cloud_run"
  | "post_git_pull"
  | "heartbeat"
  | "periodic"
  | "manual"
  | "cloud_db_changed"
  | "sync_index";

export interface CloudTursoDbChange {
  jobId?: string;
  dbId?: string;
  tables?: string[];
}

export type TursoCloudSyncSessionAction =
  | "skipped"
  | "pulled"
  | "pushed"
  | "pushed_then_pulled"
  | "failed";

export interface TursoCloudSyncSessionResult {
  syncKey: string;
  action: TursoCloudSyncSessionAction;
  trigger: TursoCloudSyncTrigger;
  push?: PushResult;
  pull?: PullResult;
  reason?: string;
  error?: string;
}

export interface TursoCloudSyncScope {
  appId?: string;
  jobId?: string;
  syncKeys?: readonly string[];
}

export interface TursoCloudSyncBridge {
  enabled: boolean;
  listLinkedSources(refresh?: boolean): Promise<TursoLinkedSource[]>;
  runExclusiveForDbPath<T>(
    dbPath: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  pushJob(
    syncKey: string,
    credentials?: import("./tursoSyncBridgeCore.js").TursoCredentials,
    pushOptions?: { force?: boolean; tableNames?: string[] },
  ): Promise<PushResult>;
  pullJob(
    syncKey: string,
    credentials?: import("./tursoSyncBridgeCore.js").TursoCredentials,
    pullOptions?: Omit<
      import("./tursoSyncBridgeCore.js").PullSourceSyncOptions,
      "jobId"
    >,
  ): Promise<PullResult>;
  resolveTursoDatabaseNameForLinked(linked: TursoLinkedSource): Promise<string>;
  fetchCredentials(
    databaseName: string,
  ): Promise<import("./tursoSyncBridgeCore.js").TursoCredentials>;
}

export function resolveSyncKeysForCloudPull(
  sources: readonly TursoLinkedSource[],
  scope?: TursoCloudSyncScope,
): string[] {
  if (scope?.syncKeys?.length) {
    return [...new Set(scope.syncKeys)];
  }

  if (scope?.jobId) {
    const linked = findLinkedSourceForJob(sources, scope.jobId);
    return linked ? [linkedSourceSyncKey(linked)] : [];
  }

  if (scope?.appId) {
    return [
      ...new Set(
        sources
          .filter((source) => source.appId === scope.appId)
          .map((source) => linkedSourceSyncKey(source)),
      ),
    ];
  }

  return [...new Set(sources.map((source) => linkedSourceSyncKey(source)))];
}

/** True when this linked source has unpushed local DB changes. */
export async function isLinkedSourceLocallyDirty(
  linked: TursoLinkedSource,
): Promise<boolean> {
  const appSource = linkedSourceAsAppDataSource(linked);
  if (shouldUseTursoReplicaForSource(appSource)) {
    try {
      const status = await syncStatusForLinkedDb(appSource);
      return status.pendingPush;
    } catch {
      return false;
    }
  }

  const syncKey = linkedSourceSyncKey(linked);
  const state = loadTursoSyncState();
  return isJobDbDirty(
    syncKey,
    linked.dbPath,
    state,
    linkedSourceAlternateKeys(linked),
  );
}

export async function isLinkedSourceRemoteAhead(
  bridge: TursoCloudSyncBridge,
  linked: TursoLinkedSource,
): Promise<boolean> {
  const syncKey = linkedSourceSyncKey(linked);
  const state = loadTursoSyncState();
  const jobState = resolveTursoPushStateEntry(
    syncKey,
    linked.dbPath,
    state,
    linkedSourceAlternateKeys(linked),
  );
  const databaseName = await bridge.resolveTursoDatabaseNameForLinked(linked);
  const creds = await bridge.fetchCredentials(databaseName);
  return bridge.runExclusiveForDbPath(linked.dbPath, async () => {
    const remote = createRemoteClient(creds);
    try {
      return await remoteAheadOfLocal(remote, {
        ...(jobState?.lastSeenRemoteVersion !== undefined
          ? { lastSeenRemoteVersion: jobState.lastSeenRemoteVersion }
          : {}),
        ...(jobState?.lastPulledLogId !== undefined
          ? { lastPulledLogId: jobState.lastPulledLogId }
          : {}),
      });
    } finally {
      remote.close();
    }
  });
}

function sessionActionFromPushPull(
  wasDirty: boolean,
  push: PushResult,
  pull?: PullResult,
): TursoCloudSyncSessionAction {
  const pushed =
    push.status === "pushed" || push.reason === "all_tables_unchanged";
  const pulled = pull?.status === "pulled";

  if (wasDirty && pushed && pulled) {
    return "pushed_then_pulled";
  }
  if (wasDirty && pushed) {
    return "pushed";
  }
  if (pulled) {
    return "pulled";
  }
  return "skipped";
}

/** One linked source: push-if-dirty, else pull-if-remote-ahead. */
export async function syncLinkedSourceFromCloud(
  bridge: TursoCloudSyncBridge,
  syncKey: string,
  options?: {
    assumeRemoteChanged?: boolean;
    trigger?: TursoCloudSyncTrigger;
    /** Get updates / explicit remote pull — skip push-if-dirty and pull from cloud first. */
    preferRemote?: boolean;
  },
): Promise<TursoCloudSyncSessionResult> {
  const trigger = options?.trigger ?? "manual";
  const sources = await bridge.listLinkedSources();
  const linked = findLinkedSourceForJob(sources, syncKey);
  if (!linked) {
    return {
      syncKey,
      action: "skipped",
      trigger,
      reason: "not_linked_to_app",
    };
  }

  const resolvedKey = linkedSourceSyncKey(linked);
  const appSource = linkedSourceAsAppDataSource(linked);
  const isReplica = shouldUseTursoReplicaForSource(appSource);
  // Only unpushed LOCAL ROWS on this DB can be clobbered by a cloud→local pull,
  // so that is the only pull gate. App *code* pending git upload is unrelated
  // to row state and must never block data sync — coupling them silently
  // disabled pulls for every app with any local source edit.
  const dirtyDbSyncKeys = new Set(
    listDbDirtySyncKeysForApp(new Set([resolvedKey]), getPaprRoot()),
  );

  // Cloud db-changed on replica DBs: pull remote first. Legacy fingerprint dirty
  // (!prev after cutover) must not trigger push-before-pull and duplicate rows.
  if (options?.assumeRemoteChanged === true && isReplica) {
    try {
      const pull = await bridge.pullJob(resolvedKey, undefined, {
        forceReconnect: true,
      });
      const stillDirty = await isLinkedSourceLocallyDirty(linked);
      if (stillDirty) {
        const push = await bridge.pushJob(resolvedKey);
        return {
          syncKey: resolvedKey,
          action: sessionActionFromPushPull(true, push),
          trigger,
          push,
          pull,
        };
      }
      return {
        syncKey: resolvedKey,
        action: pull.status === "pulled" ? "pulled" : "skipped",
        trigger,
        pull,
        ...(pull.reason ? { reason: pull.reason } : {}),
      };
    } catch (error) {
      return {
        syncKey: resolvedKey,
        action: "failed",
        trigger,
        error: (error as Error).message,
      };
    }
  }

  const localDirty = await isLinkedSourceLocallyDirty(linked);

  if (options?.preferRemote) {
    // Get updates — always pull Turso even when app git folder hash differs.
    // Git upload pending must not block cloud→local database reconcile.
    try {
      const pull = await bridge.pullJob(resolvedKey, undefined, {
        forceReconnect: true,
      });
      return {
        syncKey: resolvedKey,
        action: pull.status === "pulled" ? "pulled" : "skipped",
        trigger,
        pull,
        ...(pull.reason ? { reason: pull.reason } : {}),
      };
    } catch (error) {
      return {
        syncKey: resolvedKey,
        action: "failed",
        trigger,
        error: (error as Error).message,
      };
    }
  }

  if (localDirty) {
    try {
      const push = await bridge.pushJob(resolvedKey);
      const pulledAfterPush =
        push.status === "pushed" || push.reason === "all_tables_unchanged";
      return {
        syncKey: resolvedKey,
        action: sessionActionFromPushPull(true, push),
        trigger,
        push,
        ...(pulledAfterPush ? { reason: "push_session_includes_post_pull" } : {}),
      };
    } catch (error) {
      return {
        syncKey: resolvedKey,
        action: "failed",
        trigger,
        error: (error as Error).message,
      };
    }
  }

  // Only unpushed LOCAL ROWS on this specific DB can be clobbered by a cloud→local
  // pull — so that is the only thing that gates it. App *code* pending upload
  // (git hash) is unrelated to row state and must not block data sync; coupling
  // them silently disabled pulls for every app with any local source edit.
  // Checked before the remote-ahead network call so the skip path costs nothing.
  if (dirtyDbSyncKeys.has(resolvedKey)) {
    console.log(
      `[TursoSync] Skipping cloud→local pull for ${resolvedKey} — ` +
        `local rows not yet pushed (push first to avoid overwriting them)`,
    );
    return {
      syncKey: resolvedKey,
      action: "skipped",
      trigger,
      reason: "pending_local_db_push",
    };
  }

  const shouldPull =
    options?.assumeRemoteChanged === true ||
    (await isLinkedSourceRemoteAhead(bridge, linked));

  if (!shouldPull) {
    return {
      syncKey: resolvedKey,
      action: "skipped",
      trigger,
      reason: "remote_unchanged",
    };
  }

  try {
    const pull = await bridge.pullJob(resolvedKey);
    return {
      syncKey: resolvedKey,
      action: pull.status === "pulled" ? "pulled" : "skipped",
      trigger,
      pull,
      ...(pull.reason ? { reason: pull.reason } : {}),
    };
  } catch (error) {
    return {
      syncKey: resolvedKey,
      action: "failed",
      trigger,
      error: (error as Error).message,
    };
  }
}

export async function reconcileLinkedSourcesFromCloud(
  bridge: TursoCloudSyncBridge,
  scope?: TursoCloudSyncScope,
  options?: {
    assumeRemoteChanged?: boolean;
    trigger?: TursoCloudSyncTrigger;
    preferRemote?: boolean;
  },
): Promise<TursoCloudSyncSessionResult[]> {
  if (!bridge.enabled) {
    return [];
  }

  const sources = await bridge.listLinkedSources();
  const syncKeys = resolveSyncKeysForCloudPull(sources, scope);
  const results = await Promise.all(
    syncKeys.map((syncKey) =>
      syncLinkedSourceFromCloud(bridge, syncKey, {
        assumeRemoteChanged: options?.assumeRemoteChanged,
        trigger: options?.trigger,
        preferRemote: options?.preferRemote,
      }),
    ),
  );
  for (const result of results) {
    recordSessionResult(result);
  }

  const pulled = results.filter((r) => r.action === "pulled").length;
  const pushed = results.filter(
    (r) => r.action === "pushed" || r.action === "pushed_then_pulled",
  ).length;
  const skipped = results.filter((r) => r.action === "skipped").length;
  const failed = results.filter((r) => r.action === "failed").length;

  if (syncKeys.length > 0) {
    console.log(
      `[TursoSync] Cloud→local session (${options?.trigger ?? "manual"}): ` +
        `sources=${syncKeys.length} pulled=${pulled} pushed=${pushed} ` +
        `skipped=${skipped} failed=${failed}`,
    );
  }

  return results;
}

/** Resolve explicit app/job scope to linked sources (throws on invalid alias). */
export function resolveScopedLinkedSources(
  sources: readonly TursoLinkedSource[],
  scope: TursoCloudSyncScope,
): TursoLinkedSource[] {
  if (scope.syncKeys?.length) {
    const wanted = new Set(scope.syncKeys);
    return sources.filter((source) =>
      wanted.has(linkedSourceSyncKey(source)),
    );
  }
  return resolveLinkedSourcesForTursoPush(sources, {
    ...(scope.appId ? { appId: scope.appId } : {}),
    ...(scope.jobId ? { jobId: scope.jobId } : {}),
  });
}

/** Dedupe cloud db-changed notifications into linked sync keys (registry dbId + job writeDbIds). */
export function resolveSyncKeysFromCloudDbChanges(
  sources: readonly TursoLinkedSource[],
  changes: readonly CloudTursoDbChange[],
  jobWriteDbIds?: ReadonlyMap<string, readonly string[]>,
): string[] {
  const candidateKeys = new Set<string>();

  for (const change of changes) {
    const dbId = change.dbId?.trim();
    if (dbId) {
      candidateKeys.add(dbId);
    }
    const jobId = change.jobId?.trim();
    if (jobId) {
      candidateKeys.add(jobId);
      const writeDbIds = jobWriteDbIds?.get(jobId);
      if (writeDbIds) {
        for (const writeDbId of writeDbIds) {
          const trimmed = writeDbId.trim();
          if (trimmed) {
            candidateKeys.add(trimmed);
          }
        }
      }
    }
  }

  const resolved = new Set<string>();
  for (const key of candidateKeys) {
    const linked = findLinkedSourceForJob(sources, key);
    if (linked) {
      resolved.add(linkedSourceSyncKey(linked));
    }
  }

  return [...resolved];
}

export interface TursoSyncSessionStats {
  sessions: number;
  skipped: number;
  pulled: number;
  pushed: number;
  failed: number;
  byTrigger: Partial<Record<TursoCloudSyncTrigger, number>>;
}

let sessionStats: TursoSyncSessionStats = {
  sessions: 0,
  skipped: 0,
  pulled: 0,
  pushed: 0,
  failed: 0,
  byTrigger: {},
};

function recordSessionResult(result: TursoCloudSyncSessionResult): void {
  sessionStats.sessions += 1;
  sessionStats.byTrigger[result.trigger] =
    (sessionStats.byTrigger[result.trigger] ?? 0) + 1;

  switch (result.action) {
    case "skipped":
      sessionStats.skipped += 1;
      break;
    case "pulled":
      sessionStats.pulled += 1;
      break;
    case "pushed":
    case "pushed_then_pulled":
      sessionStats.pushed += 1;
      if (result.action === "pushed_then_pulled") {
        sessionStats.pulled += 1;
      }
      break;
    case "failed":
      sessionStats.failed += 1;
      break;
    default:
      break;
  }
}

export function getTursoSyncSessionStatsForTests(): TursoSyncSessionStats {
  return {
    ...sessionStats,
    byTrigger: { ...sessionStats.byTrigger },
  };
}

export function resetTursoSyncSessionStatsForTests(): void {
  sessionStats = {
    sessions: 0,
    skipped: 0,
    pulled: 0,
    pushed: 0,
    failed: 0,
    byTrigger: {},
  };
}

/** Cloud Turso db-changed events → scoped pull (assume remote changed per notification). */
export async function reconcileFromCloudDbChanges(
  bridge: TursoCloudSyncBridge,
  changes: readonly CloudTursoDbChange[],
  options?: {
    trigger?: TursoCloudSyncTrigger;
    jobWriteDbIds?: ReadonlyMap<string, readonly string[]>;
  },
): Promise<TursoCloudSyncSessionResult[]> {
  if (!bridge.enabled || changes.length === 0) {
    return [];
  }

  const sources = await bridge.listLinkedSources();
  const syncKeys = resolveSyncKeysFromCloudDbChanges(
    sources,
    changes,
    options?.jobWriteDbIds,
  );

  if (syncKeys.length === 0) {
    console.log(
      `[TursoSync] Cloud db-changed: ${changes.length} notification(s) — no linked sources matched`,
    );
    return [];
  }

  const results: TursoCloudSyncSessionResult[] = [];
  const trigger = options?.trigger ?? "cloud_db_changed";

  for (const syncKey of syncKeys) {
    const result = await syncLinkedSourceFromCloud(bridge, syncKey, {
      assumeRemoteChanged: true,
      trigger,
    });
    recordSessionResult(result);
    results.push(result);
  }

  const pulled = results.filter((r) => r.action === "pulled").length;
  const pushed = results.filter(
    (r) => r.action === "pushed" || r.action === "pushed_then_pulled",
  ).length;
  const skipped = results.filter((r) => r.action === "skipped").length;
  const failed = results.filter((r) => r.action === "failed").length;

  console.log(
    `[TursoSync] Cloud db-changed session: notifications=${changes.length} ` +
      `sources=${syncKeys.length} pulled=${pulled} pushed=${pushed} ` +
      `skipped=${skipped} failed=${failed}`,
  );

  return results;
}

/**
 * Poll workspace sync-index DB — one query lists which linked replicas advanced.
 * Index is a hint only; per-DB CDC + cursors remain source of truth.
 */
export async function reconcileFromSyncIndex(
  bridge: TursoCloudSyncBridge,
  options?: { trigger?: TursoCloudSyncTrigger },
): Promise<TursoCloudSyncSessionResult[]> {
  if (!bridge.enabled) {
    return [];
  }

  const indexEntries = await loadSyncIndexSnapshot((name) =>
    bridge.fetchCredentials(name),
  );
  if (indexEntries.length === 0) {
    return [];
  }

  const indexVersionByShortName = new Map(
    indexEntries.map((entry) => [entry.shortName, entry.version]),
  );

  const sources = await bridge.listLinkedSources();
  const state = loadTursoSyncState();
  const results: TursoCloudSyncSessionResult[] = [];
  const trigger = options?.trigger ?? "sync_index";

  for (const linked of sources) {
    let shortName: string;
    try {
      shortName = await bridge.resolveTursoDatabaseNameForLinked(linked);
    } catch {
      continue;
    }

    const indexVersion = indexVersionByShortName.get(shortName);
    if (indexVersion === undefined) {
      continue;
    }

    const syncKey = linkedSourceSyncKey(linked);
    const alternateKeys = linkedSourceAlternateKeys(linked);
    const jobState = resolveTursoPushStateEntry(
      syncKey,
      linked.dbPath,
      state,
      alternateKeys,
    );
    const lastSeen = jobState?.lastSeenIndexVersion ?? 0;
    if (indexVersion <= lastSeen) {
      continue;
    }

    const result = await syncLinkedSourceFromCloud(bridge, syncKey, {
      assumeRemoteChanged: true,
      trigger,
    });
    recordSessionResult(result);
    results.push(result);

    if (result.action !== "failed") {
      recordTursoIndexVersion(syncKey, linked.dbPath, indexVersion);
    }
  }

  if (results.length > 0) {
    const pulled = results.filter((r) => r.action === "pulled").length;
    const pushed = results.filter(
      (r) => r.action === "pushed" || r.action === "pushed_then_pulled",
    ).length;
    const skipped = results.filter((r) => r.action === "skipped").length;
    const failed = results.filter((r) => r.action === "failed").length;

    console.log(
      `[TursoSync] Sync-index session: sources=${results.length} ` +
        `pulled=${pulled} pushed=${pushed} skipped=${skipped} failed=${failed}`,
    );
  }

  return results;
}
