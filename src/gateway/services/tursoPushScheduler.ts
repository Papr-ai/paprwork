/**
 * Debounced Turso push — serial queue avoids provisioning rate limits on startup.
 */

import { getPaprAppsRoot } from "../../core/utils/paprRoot.js";
import { discoverTursoLinkedSources, findLinkedSourceForJob, linkedSourceSyncKey } from "./tursoLinkedSources.js";
import {
  canPerformWorkspaceDbWrite,
  getWorkspaceWriteGeneration,
} from "./workspaceWriteGuard.js";
import { getTursoSyncBridge, type TursoSyncBridge } from "./TursoSyncBridge.js";
import {
  clearDirtyAfterPush,
  isJobDbQuarantined,
  isTursoStateDbPathInWorkspace,
  loadTursoSyncState,
  recordTursoPushQuarantine,
  recordTursoPushSuccess,
} from "./tursoSyncState.js";
import type { PushResult } from "./tursoSyncBridgeCore.js";
import {
  isTursoDatabaseLimitError,
  isTursoLocalDatabaseCorruptError,
  isTursoProvisioningRateLimitError,
  isTursoSqliteBindTypeError,
} from "./tursoSyncBridgeCore.js";
import { resetTursoSyncSessionStatsForTests } from "./tursoSyncSession.js";
import { shouldAutoUploadJobFolder, shouldAutoUploadTursoForApp } from "./cloudUploadMode.js";

/** Default debounce for file-watcher / API write triggers. */
const DEFAULT_DEBOUNCE_MS = 60_000;
/** Faster debounce after job completion or explicit user link. */
const COMPLETION_DEBOUNCE_MS = 5_000;
/** Force a flush this long after the first dirty signal (debounce may keep resetting). */
const DEFAULT_MAX_WAIT_MS = 120_000;
const DEFAULT_PUSH_INTERVAL_MS = 1_500;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;
/** Back off scheduler retries after a failed push (avoids max-wait log storms). */
const DEFAULT_PUSH_FAILURE_BACKOFF_MS = 60_000;
/** Do not retry Turso push when local state cannot produce a remote delta. */
const PERMANENT_PUSH_SKIP_REASONS = new Set([
  "no_syncable_tables",
  "no_matching_tables",
  "local_db_empty",
  "local_db_missing",
]);

function isPermanentPushSkip(result: PushResult): boolean {
  return (
    result.status === "skipped" &&
    result.reason !== undefined &&
    PERMANENT_PUSH_SKIP_REASONS.has(result.reason)
  );
}
/** Minimum gap between repeated max-wait flush logs for the same sync key. */
const MAX_WAIT_LOG_COOLDOWN_MS = 30_000;

export type TursoPushPriority = "normal" | "completion";

export type TursoPushTrigger =
  | "watcher"
  | "manual"
  | "post_git"
  | "startup"
  | "completion"
  | "max_wait"
  | "unknown";

const jobTimers = new Map<string, NodeJS.Timeout>();
const maxWaitTimers = new Map<string, NodeJS.Timeout>();
/** First dirty timestamp per syncKey — not reset on subsequent writes until push succeeds. */
const firstDirtyAtMs = new Map<string, number>();
let allLinkedTimer: NodeJS.Timeout | null = null;

export interface TursoPushSchedulerStats {
  schedules: number;
  enqueues: number;
  pushJobCalls: number;
  schedulesByKey: Record<string, number>;
  enqueuesByKey: Record<string, number>;
}

let pushSchedulerStats: TursoPushSchedulerStats = {
  schedules: 0,
  enqueues: 0,
  pushJobCalls: 0,
  schedulesByKey: {},
  enqueuesByKey: {},
};

function bumpStat(
  bucket: Record<string, number>,
  syncKey: string,
): void {
  bucket[syncKey] = (bucket[syncKey] ?? 0) + 1;
}

export function getTursoPushSchedulerStatsForTests(): TursoPushSchedulerStats {
  return {
    ...pushSchedulerStats,
    schedulesByKey: { ...pushSchedulerStats.schedulesByKey },
    enqueuesByKey: { ...pushSchedulerStats.enqueuesByKey },
  };
}

export function resetTursoPushSchedulerStatsForTests(): void {
  pushSchedulerStats = {
    schedules: 0,
    enqueues: 0,
    pushJobCalls: 0,
    schedulesByKey: {},
    enqueuesByKey: {},
  };
}

const pushQueue: string[] = [];
const queuedJobIds = new Set<string>();
/** Jobs currently executing pushJob — still pending from max-wait's perspective. */
const pushInFlightSyncKeys = new Set<string>();
const pushFailureBackoffUntilMs = new Map<string, number>();
const lastMaxWaitLogAtMs = new Map<string, number>();
let queueProcessing = false;
let rateLimitUntilMs = 0;
let rateLimitBackoffMs = DEFAULT_RATE_LIMIT_BACKOFF_MS;

function debounceMs(priority: TursoPushPriority): number {
  if (priority === "completion") {
    const raw = process.env.TURSO_PUSH_COMPLETION_DEBOUNCE_MS;
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
    return COMPLETION_DEBOUNCE_MS;
  }

  const raw = process.env.TURSO_PUSH_DEBOUNCE_MS;
  if (!raw) {
    return DEFAULT_DEBOUNCE_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEBOUNCE_MS;
}

function pushIntervalMs(): number {
  const raw = process.env.TURSO_PUSH_INTERVAL_MS;
  if (!raw) {
    return DEFAULT_PUSH_INTERVAL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PUSH_INTERVAL_MS;
}

function maxWaitMs(): number {
  const raw = process.env.TURSO_PUSH_MAX_WAIT_MS;
  if (!raw) {
    return DEFAULT_MAX_WAIT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_WAIT_MS;
}

function defaultAppsRoot(): string {
  return getPaprAppsRoot();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logTursoSchedule(
  syncKey: string,
  trigger: TursoPushTrigger,
  detail?: string,
): void {
  const suffix = detail ? ` — ${detail}` : "";
  console.log(
    `[TursoPushScheduler] Schedule push for ${syncKey} (trigger=${trigger}${suffix})`,
  );
}

function clearDebounceTimer(syncKey: string): void {
  const debounceTimer = jobTimers.get(syncKey);
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    jobTimers.delete(syncKey);
  }
}

function clearMaxWaitTimer(syncKey: string): void {
  const maxWaitTimer = maxWaitTimers.get(syncKey);
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimers.delete(syncKey);
  }
}

function clearDirtyTracking(syncKey: string): void {
  clearDebounceTimer(syncKey);
  clearMaxWaitTimer(syncKey);
  firstDirtyAtMs.delete(syncKey);
  lastMaxWaitLogAtMs.delete(syncKey);
  pushFailureBackoffUntilMs.delete(syncKey);
}

function pushFailureBackoffMs(): number {
  const raw = process.env.TURSO_PUSH_FAILURE_BACKOFF_MS;
  if (!raw) {
    return DEFAULT_PUSH_FAILURE_BACKOFF_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_PUSH_FAILURE_BACKOFF_MS;
}

function isInPushFailureBackoff(syncKey: string): boolean {
  const until = pushFailureBackoffUntilMs.get(syncKey);
  return until !== undefined && Date.now() < until;
}

function notePushFailureBackoff(syncKey: string): void {
  pushFailureBackoffUntilMs.set(syncKey, Date.now() + pushFailureBackoffMs());
}

function clearPushSchedulerJob(schedulerKey: string, dbPath?: string, stateKey?: string): void {
  clearDirtyTracking(schedulerKey);
  const dirtyKey = stateKey ?? schedulerKey;
  if (dbPath) {
    clearDirtyAfterPush(dirtyKey);
  }
}

function recordSuccessfulPush(
  stateKey: string,
  dbPath: string,
  result: PushResult,
): void {
  recordTursoPushSuccess(
    stateKey,
    dbPath,
    undefined,
    result.tableFingerprints,
    result.lastPushedLogId,
  );
}

function armMaxWaitTimer(syncKey: string): void {
  if (maxWaitTimers.has(syncKey) || isMaxWaitFlushPending(syncKey)) {
    return;
  }

  const first = firstDirtyAtMs.get(syncKey) ?? Date.now();
  firstDirtyAtMs.set(syncKey, first);
  const remaining = Math.max(0, maxWaitMs() - (Date.now() - first));

  const timer = setTimeout(() => {
    maxWaitTimers.delete(syncKey);
    clearDebounceTimer(syncKey);
    if (isMaxWaitFlushPending(syncKey)) {
      return;
    }
    logTursoSchedule(syncKey, "max_wait", `elapsed ${maxWaitMs()}ms`);
    enqueueTursoPush(syncKey, true);
  }, remaining);

  maxWaitTimers.set(syncKey, timer);
}

function noteDirty(syncKey: string): void {
  if (!firstDirtyAtMs.has(syncKey)) {
    firstDirtyAtMs.set(syncKey, Date.now());
  }
  armMaxWaitTimer(syncKey);
}

/** True when max-wait already triggered a flush and the job is queued or pushing. */
function isMaxWaitFlushPending(syncKey: string): boolean {
  return queuedJobIds.has(syncKey) || pushInFlightSyncKeys.has(syncKey);
}

function flushIfMaxWaitElapsed(syncKey: string, trigger: TursoPushTrigger): boolean {
  const first = firstDirtyAtMs.get(syncKey);
  if (first === undefined) {
    return false;
  }
  if (Date.now() - first < maxWaitMs()) {
    return false;
  }
  clearDebounceTimer(syncKey);
  clearMaxWaitTimer(syncKey);
  if (isMaxWaitFlushPending(syncKey)) {
    return true;
  }
  if (isInPushFailureBackoff(syncKey)) {
    return true;
  }
  const lastLogAt = lastMaxWaitLogAtMs.get(syncKey) ?? 0;
  const logCooldownElapsed = Date.now() - lastLogAt >= MAX_WAIT_LOG_COOLDOWN_MS;
  if (logCooldownElapsed) {
    logTursoSchedule(syncKey, trigger, "max-wait elapsed — flushing now");
    lastMaxWaitLogAtMs.set(syncKey, Date.now());
  }
  enqueueTursoPush(syncKey, true);
  return true;
}

async function executePushForJob(
  bridge: TursoSyncBridge,
  syncKey: string,
): Promise<void> {
  if (!(await bridge.isJobLinkedToApp(syncKey))) {
    clearDirtyTracking(syncKey);
    return;
  }

  const sources = await bridge.listLinkedSources(true);
  const linked = findLinkedSourceForJob(sources, syncKey);
  if (!linked) {
    clearDirtyTracking(syncKey);
    return;
  }

  const resolvedSyncKey = linkedSourceSyncKey(linked);

  if (
    !canPerformWorkspaceDbWrite(
      getWorkspaceWriteGeneration(),
      linked.dbPath,
      `turso push ${resolvedSyncKey}`,
    )
  ) {
    clearDirtyTracking(syncKey);
    clearPushSchedulerJob(syncKey, linked.dbPath, resolvedSyncKey);
    return;
  }

  if (!(await bridge.linkedSourceNeedsPush(linked))) {
    clearPushSchedulerJob(syncKey, linked.dbPath, resolvedSyncKey);
    return;
  }

  try {
    const result = await bridge.pushJob(syncKey);
    pushSchedulerStats.pushJobCalls += 1;
    if (result.status === "pushed") {
      recordSuccessfulPush(resolvedSyncKey, linked.dbPath, result);
      clearDirtyTracking(syncKey);
      const skipped =
        result.skippedTables && result.skippedTables.length > 0
          ? `, skipped ${result.skippedTables.length} unchanged table(s)`
          : "";
      console.log(
        `[TursoPushScheduler] Pushed ${resolvedSyncKey} (${result.tables.length} table(s)${skipped})`,
      );
      return;
    }

    if (result.reason === "all_tables_unchanged" && result.tableFingerprints) {
      recordSuccessfulPush(resolvedSyncKey, linked.dbPath, result);
      clearDirtyTracking(syncKey);
      return;
    }

    if (isPermanentPushSkip(result)) {
      recordSuccessfulPush(resolvedSyncKey, linked.dbPath, {
        ...result,
        tableFingerprints: result.tableFingerprints ?? {},
      });
      clearPushSchedulerJob(syncKey, linked.dbPath, resolvedSyncKey);
      return;
    }

    if (!(await bridge.linkedSourceNeedsPush(linked))) {
      clearPushSchedulerJob(syncKey, linked.dbPath, resolvedSyncKey);
      return;
    }

    notePushFailureBackoff(syncKey);
    console.warn(
      `[TursoPushScheduler] Push skipped for ${resolvedSyncKey}: ${result.reason ?? "unknown"}`,
    );
  } catch (error) {
    const message = (error as Error).message;
    if (
      isTursoLocalDatabaseCorruptError(message) ||
      isTursoSqliteBindTypeError(message)
    ) {
      recordTursoPushQuarantine(resolvedSyncKey, linked.dbPath, message);
      clearDirtyTracking(syncKey);
      return;
    }
    notePushFailureBackoff(syncKey);
    throw error;
  }
}

function logPushFailure(jobId: string, message: string): void {
  if (
    isTursoDatabaseLimitError(message) ||
    isTursoProvisioningRateLimitError(message) ||
    isTursoLocalDatabaseCorruptError(message) ||
    isTursoSqliteBindTypeError(message)
  ) {
    return;
  }
  console.warn(
    `[TursoPushScheduler] Push failed for ${jobId}:`,
    message.slice(0, 120),
  );
}

function enqueueTursoPush(jobId: string, front = false): void {
  if (pushInFlightSyncKeys.has(jobId)) {
    console.warn(
      `[TursoPushScheduler] Push already in-flight for ${jobId} — coalescing enqueue`,
    );
  }
  if (queuedJobIds.has(jobId)) {
    return;
  }
  pushSchedulerStats.enqueues += 1;
  bumpStat(pushSchedulerStats.enqueuesByKey, jobId);
  queuedJobIds.add(jobId);
  if (front) {
    pushQueue.unshift(jobId);
  } else {
    pushQueue.push(jobId);
  }
  void processTursoPushQueue();
}

async function processTursoPushQueue(): Promise<void> {
  if (queueProcessing) {
    return;
  }
  queueProcessing = true;

  const bridge = getTursoSyncBridge();
  if (!bridge) {
    pushQueue.length = 0;
    queuedJobIds.clear();
    queueProcessing = false;
    return;
  }

  try {
    while (pushQueue.length > 0) {
      const waitMs = rateLimitUntilMs - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      const jobId = pushQueue.shift();
      if (!jobId) {
        break;
      }
      queuedJobIds.delete(jobId);
      pushInFlightSyncKeys.add(jobId);

      try {
        await executePushForJob(bridge, jobId);
        rateLimitBackoffMs = DEFAULT_RATE_LIMIT_BACKOFF_MS;
      } catch (error) {
        const message = (error as Error).message;
        if (
          isTursoLocalDatabaseCorruptError(message) ||
          isTursoSqliteBindTypeError(message)
        ) {
          const sources = await bridge.listLinkedSources(true);
          const linked = findLinkedSourceForJob(sources, jobId);
          if (linked) {
            recordTursoPushQuarantine(linkedSourceSyncKey(linked), linked.dbPath, message);
          }
          clearDirtyTracking(jobId);
          continue;
        }
        if (isTursoDatabaseLimitError(message)) {
          break;
        }
        if (isTursoProvisioningRateLimitError(message)) {
          bridge.invalidateCredentialsCache();
          pushQueue.unshift(jobId);
          queuedJobIds.add(jobId);
          rateLimitUntilMs = Date.now() + rateLimitBackoffMs;
          rateLimitBackoffMs = Math.min(rateLimitBackoffMs * 2, 120_000);
          console.warn(
            `[TursoPushScheduler] Turso provisioning rate limited — backing off ${Math.round(
              rateLimitBackoffMs / 1000,
            )}s (${pushQueue.length} job(s) queued)`,
          );
          break;
        }
        logPushFailure(jobId, message);
      } finally {
        pushInFlightSyncKeys.delete(jobId);
      }

      if (pushQueue.length > 0) {
        await sleep(pushIntervalMs());
      }
    }
  } finally {
    queueProcessing = false;
    if (pushQueue.length > 0) {
      void processTursoPushQueue();
    }
  }
}

export function scheduleTursoPushForJob(
  jobId: string,
  priority: TursoPushPriority = "normal",
  trigger: TursoPushTrigger = "unknown",
): void {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }

  const syncState = loadTursoSyncState();
  if (isJobDbQuarantined(jobId, syncState)) {
    return;
  }

  const syncEntry = syncState.jobs[jobId];
  if (
    syncEntry?.dbPath &&
    !isTursoStateDbPathInWorkspace(syncEntry.dbPath)
  ) {
    return;
  }

  if (trigger !== "manual" && isInPushFailureBackoff(jobId)) {
    return;
  }

  if (trigger !== "manual" && !shouldAutoUploadJobFolder(jobId)) {
    logTursoSchedule(jobId, trigger, "skipped (manual upload mode)");
    return;
  }

  const hadDebounceTimer = jobTimers.has(jobId);
  noteDirty(jobId);
  if (flushIfMaxWaitElapsed(jobId, trigger)) {
    return;
  }

  pushSchedulerStats.schedules += 1;
  bumpStat(pushSchedulerStats.schedulesByKey, jobId);

  if (!hadDebounceTimer) {
    logTursoSchedule(jobId, trigger, `debounce ${debounceMs(priority)}ms`);
  }

  clearDebounceTimer(jobId);

  const timer = setTimeout(() => {
    jobTimers.delete(jobId);
    logTursoSchedule(jobId, trigger, "debounce elapsed");
    enqueueTursoPush(jobId);
  }, debounceMs(priority));

  jobTimers.set(jobId, timer);
}

export function scheduleTursoPushAllLinked(
  trigger: TursoPushTrigger = "post_git",
): void {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }

  if (allLinkedTimer) {
    clearTimeout(allLinkedTimer);
  }

  logTursoSchedule("*", trigger, `all linked debounce ${debounceMs("normal")}ms`);

  allLinkedTimer = setTimeout(() => {
    allLinkedTimer = null;
    void enqueueDirtyLinkedJobs(
      bridge.getAppsRootDir() ?? defaultAppsRoot(),
      trigger,
    );
  }, debounceMs("normal"));
}

async function enqueueDirtyLinkedJobs(
  appsRootDir: string,
  trigger: TursoPushTrigger = "startup",
): Promise<void> {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }

  const sources = await discoverTursoLinkedSources(appsRootDir);
  let enqueued = 0;
  for (const source of sources) {
    if (trigger !== "manual" && !shouldAutoUploadTursoForApp(source.appId)) {
      continue;
    }
    const syncKey = linkedSourceSyncKey(source);
    if (!(await bridge.linkedSourceNeedsPush(source))) {
      continue;
    }
    logTursoSchedule(syncKey, trigger, "dirty linked source");
    noteDirty(syncKey);
    if (!flushIfMaxWaitElapsed(syncKey, trigger)) {
      enqueueTursoPush(syncKey);
    }
    enqueued += 1;
  }
  if (enqueued > 0) {
    console.log(
      `[TursoPushScheduler] Queued ${enqueued} dirty linked job DB(s) for Turso push`,
    );
  }
}

export async function pushDirtyLinkedJobsOnStartup(
  appsRootDir?: string,
): Promise<void> {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }

  const { getPaprRoot } = await import("../../core/utils/paprRoot.js");
  const { pruneTursoSyncStateForWorkspace } = await import("./tursoSyncState.js");
  const pruned = pruneTursoSyncStateForWorkspace(getPaprRoot());
  if (pruned > 0) {
    console.log(
      `[TursoPushScheduler] Pruned ${pruned} stale sync-state row(s) for active workspace`,
    );
  }

  const root = appsRootDir ?? bridge.getAppsRootDir() ?? defaultAppsRoot();
  await enqueueDirtyLinkedJobs(root, "startup");
}

function removeFromPushQueue(syncKey: string): void {
  for (let index = pushQueue.length - 1; index >= 0; index -= 1) {
    if (pushQueue[index] === syncKey) {
      pushQueue.splice(index, 1);
    }
  }
  queuedJobIds.delete(syncKey);
}

/** Cancel debounced/queued scheduler pushes before an ordered app flush. */
export function cancelScheduledTursoPushForSyncKeys(
  syncKeys: readonly string[],
): void {
  for (const syncKey of syncKeys) {
    if (!syncKey) {
      continue;
    }
    clearDebounceTimer(syncKey);
    clearMaxWaitTimer(syncKey);
    removeFromPushQueue(syncKey);
  }
}

/** Wait for in-flight scheduler pushes so ordered flush owns the SQLite file. */
export async function awaitTursoPushInFlightForSyncKeys(
  syncKeys: readonly string[],
  timeoutMs = 60_000,
): Promise<void> {
  const keys = [...new Set(syncKeys.filter(Boolean))];
  if (keys.length === 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!keys.some((key) => pushInFlightSyncKeys.has(key))) {
      return;
    }
    await sleep(50);
  }

  console.warn(
    `[TursoPushScheduler] Timed out waiting for in-flight push (${keys.join(", ")})`,
  );
}

/** Test hook — wait until the push queue is idle. */
export async function awaitTursoPushQueueForTests(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!queueProcessing && pushQueue.length === 0 && pushInFlightSyncKeys.size === 0) {
      return;
    }
    await sleep(0);
  }
  throw new Error("Turso push queue did not drain in time");
}

/** Drop debounced/queued pushes (e.g. before org/namespace workspace switch). */
export function cancelAllScheduledTursoPushes(reason = "workspace switch"): void {
  for (const timer of jobTimers.values()) {
    clearTimeout(timer);
  }
  jobTimers.clear();
  for (const timer of maxWaitTimers.values()) {
    clearTimeout(timer);
  }
  maxWaitTimers.clear();
  firstDirtyAtMs.clear();
  if (allLinkedTimer) {
    clearTimeout(allLinkedTimer);
    allLinkedTimer = null;
  }
  pushQueue.length = 0;
  queuedJobIds.clear();
  pushFailureBackoffUntilMs.clear();
  lastMaxWaitLogAtMs.clear();
  queueProcessing = false;
  rateLimitUntilMs = 0;
  rateLimitBackoffMs = DEFAULT_RATE_LIMIT_BACKOFF_MS;
  console.log(`[TursoPushScheduler] Cancelled scheduled Turso pushes (${reason})`);
}

/** Test hook — flush queue state between tests. */
export function resetTursoPushQueueForTests(): void {
  resetTursoPushSchedulerStatsForTests();
  cancelAllScheduledTursoPushes("test reset");
  pushInFlightSyncKeys.clear();
}

/** Test hook — inspect max-wait state. */
export function getFirstDirtyAtMsForTests(syncKey: string): number | undefined {
  return firstDirtyAtMs.get(syncKey);
}

/** Reset push scheduler + pull session counters between E2E scenarios. */
export function resetTursoSyncTestHooks(): void {
  resetTursoPushQueueForTests();
  resetTursoSyncSessionStatsForTests();
}
