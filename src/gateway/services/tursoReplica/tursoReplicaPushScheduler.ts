/**
 * Debounced Turso Sync replica drain (pull → push) for Plan A registry DBs.
 * Reuses the legacy scheduler timing knobs; executes pushLinkedDbViaTursoReplica.
 */

import { getPaprAppsRoot } from "../../../core/utils/paprRoot.js";
import { shouldAutoUploadReplicaSyncKey } from "../cloudUploadMode.js";
import * as path from "path";
import {
  dedupeLinkedSourcesBySyncKey,
  discoverTursoLinkedSources,
  findLinkedSourceForJob,
  linkedSourceAsAppDataSource,
  linkedSourceSyncKey,
  type TursoLinkedSource,
} from "../tursoLinkedSources.js";
import { ensureTursoSyncBridge } from "../TursoSyncBridge.js";
import type { AppDataSource } from "../appDataSources.js";
import {
  getDatabaseRegistryService,
  initializeDatabaseRegistry,
} from "../DatabaseRegistryService.js";
import {
  isTursoReplicaOnline,
  isTursoReplicaSyncFeatureEnabled,
} from "../../utils/tursoReplicaEnabled.js";
import {
  pushLinkedDbViaTursoReplica,
  shouldUseTursoReplicaForSource,
  syncStatusForLinkedDb,
} from "./tursoReplicaRouting.js";
import type {
  TursoPushPriority,
  TursoPushTrigger,
} from "../tursoPushScheduler.js";

const DEFAULT_DEBOUNCE_MS = 60_000;
const COMPLETION_DEBOUNCE_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 120_000;
const DEFAULT_PUSH_INTERVAL_MS = 1_500;
const DEFAULT_PUSH_FAILURE_BACKOFF_MS = 60_000;
const MAX_WAIT_LOG_COOLDOWN_MS = 30_000;

const jobTimers = new Map<string, NodeJS.Timeout>();
const maxWaitTimers = new Map<string, NodeJS.Timeout>();
const firstDirtyAtMs = new Map<string, number>();
const pushQueue: string[] = [];
const queuedSyncKeys = new Set<string>();
const pushInFlightSyncKeys = new Set<string>();
const pushFailureBackoffUntilMs = new Map<string, number>();
const lastMaxWaitLogAtMs = new Map<string, number>();
let allLinkedTimer: NodeJS.Timeout | null = null;
let queueProcessing = false;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logReplicaSchedule(
  syncKey: string,
  trigger: TursoPushTrigger,
  detail?: string,
): void {
  const suffix = detail ? ` — ${detail}` : "";
  console.log(
    `[TursoReplicaPushScheduler] Schedule push for ${syncKey} (trigger=${trigger}${suffix})`,
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

function isInPushFailureBackoff(syncKey: string): boolean {
  const until = pushFailureBackoffUntilMs.get(syncKey);
  return until !== undefined && Date.now() < until;
}

function notePushFailureBackoff(syncKey: string): void {
  pushFailureBackoffUntilMs.set(syncKey, Date.now() + pushFailureBackoffMs());
}

function isMaxWaitFlushPending(syncKey: string): boolean {
  return queuedSyncKeys.has(syncKey) || pushInFlightSyncKeys.has(syncKey);
}

function noteDirty(syncKey: string): void {
  if (!firstDirtyAtMs.has(syncKey)) {
    firstDirtyAtMs.set(syncKey, Date.now());
  }
  armMaxWaitTimer(syncKey);
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
    logReplicaSchedule(syncKey, "max_wait", `elapsed ${maxWaitMs()}ms`);
    enqueueReplicaPush(syncKey, true);
  }, remaining);
  maxWaitTimers.set(syncKey, timer);
}

function flushIfMaxWaitElapsed(
  syncKey: string,
  trigger: TursoPushTrigger,
): boolean {
  const first = firstDirtyAtMs.get(syncKey);
  if (first === undefined || Date.now() - first < maxWaitMs()) {
    return false;
  }
  clearDebounceTimer(syncKey);
  clearMaxWaitTimer(syncKey);
  if (isMaxWaitFlushPending(syncKey) || isInPushFailureBackoff(syncKey)) {
    return true;
  }
  const lastLogAt = lastMaxWaitLogAtMs.get(syncKey) ?? 0;
  if (Date.now() - lastLogAt >= MAX_WAIT_LOG_COOLDOWN_MS) {
    logReplicaSchedule(syncKey, trigger, "max-wait elapsed — flushing now");
    lastMaxWaitLogAtMs.set(syncKey, Date.now());
  }
  enqueueReplicaPush(syncKey, true);
  return true;
}

function registryRecordAsSource(record: {
  dbId: string;
  localPath: string;
  createdAt: string;
  label?: string;
}): AppDataSource {
  return {
    id: record.dbId,
    type: "sqlite",
    dbId: record.dbId,
    alias: record.label ?? record.dbId,
    dbPath: record.localPath,
    tables: [],
    linkedAt: record.createdAt,
  };
}

async function resolveReplicaSourceForSyncKey(
  syncKey: string,
): Promise<AppDataSource | null> {
  const bridge = ensureTursoSyncBridge();
  if (!bridge.enabled) {
    return null;
  }

  const sources = await bridge.listLinkedSources(true);
  const linked = findLinkedSourceForJob(sources, syncKey);
  if (linked) {
    const source = linkedSourceAsAppDataSource(linked);
    return shouldUseTursoReplicaForSource(source) ? source : null;
  }

  await initializeDatabaseRegistry();
  const registry = getDatabaseRegistryService();
  const record =
    registry.getById(syncKey) ?? registry.getByPath(syncKey);
  if (!record || record.syncMode !== "replica") {
    return null;
  }
  return registryRecordAsSource(record);
}

async function replicaSourceNeedsPush(source: AppDataSource): Promise<boolean> {
  try {
    const status = await syncStatusForLinkedDb(source);
    return (
      status.pendingPush ||
      Boolean(status.lastPushError) ||
      status.migrationConflict
    );
  } catch {
    return true;
  }
}

function replicaPaprDir(): string {
  const bridge = ensureTursoSyncBridge();
  const appsRoot = bridge.getAppsRootDir() ?? getPaprAppsRoot();
  return path.dirname(appsRoot);
}

function shouldScheduleReplicaPush(
  syncKey: string,
  trigger: TursoPushTrigger,
): boolean {
  if (trigger === "manual") {
    return true;
  }
  if (!shouldAutoUploadReplicaSyncKey(syncKey, replicaPaprDir())) {
    logReplicaSchedule(syncKey, trigger, "skipped (manual upload mode)");
    return false;
  }
  return true;
}

async function executeReplicaPushForSyncKey(syncKey: string): Promise<void> {
  if (!isTursoReplicaSyncFeatureEnabled()) {
    clearDirtyTracking(syncKey);
    return;
  }

  if (!shouldAutoUploadReplicaSyncKey(syncKey, replicaPaprDir())) {
    clearDirtyTracking(syncKey);
    return;
  }

  const source = await resolveReplicaSourceForSyncKey(syncKey);
  if (!source) {
    clearDirtyTracking(syncKey);
    return;
  }

  if (!isTursoReplicaOnline()) {
    notePushFailureBackoff(syncKey);
    return;
  }

  try {
    const result = await pushLinkedDbViaTursoReplica(source);
    if (result.ok) {
      const stillPending = await replicaSourceNeedsPush(source);
      if (stillPending) {
        noteDirty(syncKey);
        enqueueReplicaPush(syncKey, true);
        console.log(
          `[TursoReplicaPushScheduler] Backlog remains for ${syncKey} — queued follow-up push`,
        );
        return;
      }
      clearDirtyTracking(syncKey);
      console.log(`[TursoReplicaPushScheduler] Pushed ${syncKey} (replica)`);
      return;
    }

    notePushFailureBackoff(syncKey);
    console.warn(
      `[TursoReplicaPushScheduler] Push failed for ${syncKey}: ${result.error ?? "unknown"}`,
    );
  } catch (error) {
    notePushFailureBackoff(syncKey);
    console.warn(
      `[TursoReplicaPushScheduler] Push error for ${syncKey}:`,
      (error as Error).message.slice(0, 120),
    );
  }
}

function enqueueReplicaPush(syncKey: string, front = false): void {
  if (queuedSyncKeys.has(syncKey)) {
    return;
  }
  queuedSyncKeys.add(syncKey);
  if (front) {
    pushQueue.unshift(syncKey);
  } else {
    pushQueue.push(syncKey);
  }
  void processReplicaPushQueue();
}

async function processReplicaPushQueue(): Promise<void> {
  if (queueProcessing) {
    return;
  }
  queueProcessing = true;

  if (!isTursoReplicaSyncFeatureEnabled()) {
    pushQueue.length = 0;
    queuedSyncKeys.clear();
    queueProcessing = false;
    return;
  }

  try {
    while (pushQueue.length > 0) {
      const syncKey = pushQueue.shift();
      if (!syncKey) {
        break;
      }
      queuedSyncKeys.delete(syncKey);
      pushInFlightSyncKeys.add(syncKey);
      try {
        await executeReplicaPushForSyncKey(syncKey);
      } finally {
        pushInFlightSyncKeys.delete(syncKey);
      }
      if (pushQueue.length > 0) {
        await sleep(pushIntervalMs());
      }
    }
  } finally {
    queueProcessing = false;
    if (pushQueue.length > 0) {
      void processReplicaPushQueue();
    }
  }
}

export function scheduleTursoReplicaPushForSyncKey(
  syncKey: string,
  priority: TursoPushPriority = "normal",
  trigger: TursoPushTrigger = "unknown",
): void {
  if (!isTursoReplicaSyncFeatureEnabled()) {
    return;
  }

  const bridge = ensureTursoSyncBridge();
  if (!bridge.enabled) {
    return;
  }

  if (trigger !== "manual" && isInPushFailureBackoff(syncKey)) {
    return;
  }

  if (!shouldScheduleReplicaPush(syncKey, trigger)) {
    return;
  }

  const hadDebounceTimer = jobTimers.has(syncKey);
  noteDirty(syncKey);
  if (flushIfMaxWaitElapsed(syncKey, trigger)) {
    return;
  }

  if (!hadDebounceTimer) {
    logReplicaSchedule(syncKey, trigger, `debounce ${debounceMs(priority)}ms`);
  }

  clearDebounceTimer(syncKey);
  const timer = setTimeout(() => {
    jobTimers.delete(syncKey);
    logReplicaSchedule(syncKey, trigger, "debounce elapsed");
    enqueueReplicaPush(syncKey);
  }, debounceMs(priority));
  jobTimers.set(syncKey, timer);
}

export function scheduleTursoReplicaPushAllLinked(
  trigger: TursoPushTrigger = "post_git",
): void {
  if (!isTursoReplicaSyncFeatureEnabled()) {
    return;
  }

  const bridge = ensureTursoSyncBridge();
  if (!bridge.enabled) {
    return;
  }

  if (allLinkedTimer) {
    clearTimeout(allLinkedTimer);
  }

  logReplicaSchedule("*", trigger, `all linked debounce ${debounceMs("normal")}ms`);

  allLinkedTimer = setTimeout(() => {
    allLinkedTimer = null;
    void enqueuePendingReplicaLinkedSources(
      bridge.getAppsRootDir() ?? getPaprAppsRoot(),
      trigger,
    );
  }, debounceMs("normal"));
}

async function enqueuePendingReplicaLinkedSources(
  appsRootDir: string,
  trigger: TursoPushTrigger,
): Promise<void> {
  if (!isTursoReplicaSyncFeatureEnabled()) {
    return;
  }

  const sources = dedupeLinkedSourcesBySyncKey(
    await discoverTursoLinkedSources(appsRootDir),
  );

  let enqueued = 0;
  for (const linked of sources) {
    const source = linkedSourceAsAppDataSource(linked);
    if (!shouldUseTursoReplicaForSource(source)) {
      continue;
    }
    const syncKey = linkedSourceSyncKey(linked);
    if (!shouldScheduleReplicaPush(syncKey, trigger)) {
      continue;
    }
    if (!(await replicaSourceNeedsPush(source))) {
      continue;
    }
    logReplicaSchedule(syncKey, trigger, "pending replica source");
    noteDirty(syncKey);
    if (!flushIfMaxWaitElapsed(syncKey, trigger)) {
      enqueueReplicaPush(syncKey);
    }
    enqueued += 1;
  }

  if (enqueued > 0) {
    console.log(
      `[TursoReplicaPushScheduler] Queued ${enqueued} pending replica DB(s) for push`,
    );
  }
}

export async function pushPendingReplicaDbsOnStartup(
  appsRootDir?: string,
): Promise<void> {
  const bridge = ensureTursoSyncBridge();
  if (!bridge.enabled || !isTursoReplicaSyncFeatureEnabled()) {
    return;
  }

  const root = appsRootDir ?? bridge.getAppsRootDir() ?? getPaprAppsRoot();
  await enqueuePendingReplicaLinkedSources(root, "startup");
}

export function cancelScheduledTursoReplicaPushes(
  syncKeys: readonly string[],
): void {
  for (const syncKey of syncKeys) {
    if (!syncKey) {
      continue;
    }
    clearDirtyTracking(syncKey);
    for (let index = pushQueue.length - 1; index >= 0; index -= 1) {
      if (pushQueue[index] === syncKey) {
        pushQueue.splice(index, 1);
      }
    }
    queuedSyncKeys.delete(syncKey);
  }
}

export function cancelAllScheduledTursoReplicaPushes(
  reason = "workspace switch",
): void {
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
  queuedSyncKeys.clear();
  pushFailureBackoffUntilMs.clear();
  lastMaxWaitLogAtMs.clear();
  queueProcessing = false;
  console.log(
    `[TursoReplicaPushScheduler] Cancelled scheduled replica pushes (${reason})`,
  );
}

export async function awaitTursoReplicaPushQueueForTests(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      !queueProcessing &&
      pushQueue.length === 0 &&
      pushInFlightSyncKeys.size === 0
    ) {
      return;
    }
    await sleep(0);
  }
  throw new Error("Turso replica push queue did not drain in time");
}

export function resetTursoReplicaPushSchedulerForTests(): void {
  cancelAllScheduledTursoReplicaPushes("test reset");
  pushInFlightSyncKeys.clear();
}

/** @internal test helper */
export function getFirstReplicaDirtyAtMsForTests(
  syncKey: string,
): number | undefined {
  return firstDirtyAtMs.get(syncKey);
}

/** @internal test helper — resolve linked source scheduling without executing push */
export async function listReplicaLinkedSourcesForTests(
  appsRootDir: string,
): Promise<TursoLinkedSource[]> {
  const sources = dedupeLinkedSourcesBySyncKey(
    await discoverTursoLinkedSources(appsRootDir),
  );
  return sources.filter((linked) =>
    shouldUseTursoReplicaForSource(linkedSourceAsAppDataSource(linked)),
  );
}
