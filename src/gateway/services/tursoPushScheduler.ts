/**
 * Debounced Turso push — serial queue avoids provisioning rate limits on startup.
 */

import { getPaprAppsRoot } from "../../core/utils/paprRoot.js";
import { discoverTursoLinkedSources, findLinkedSourceForJob, linkedSourceSyncKey } from "./tursoLinkedSources.js";
import { getTursoSyncBridge, type TursoSyncBridge } from "./TursoSyncBridge.js";
import {
  recordTursoPushQuarantine,
  recordTursoPushSuccess,
} from "./tursoSyncState.js";
import {
  isTursoDatabaseLimitError,
  isTursoLocalDatabaseCorruptError,
  isTursoProvisioningRateLimitError,
  isTursoSqliteBindTypeError,
} from "./tursoSyncBridgeCore.js";

/** Default debounce for file-watcher / API write triggers. */
const DEFAULT_DEBOUNCE_MS = 60_000;
/** Faster debounce after job completion or explicit user link. */
const COMPLETION_DEBOUNCE_MS = 5_000;
const DEFAULT_PUSH_INTERVAL_MS = 1_500;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;

const jobTimers = new Map<string, NodeJS.Timeout>();
let allLinkedTimer: NodeJS.Timeout | null = null;

const pushQueue: string[] = [];
const queuedJobIds = new Set<string>();
let queueProcessing = false;
let rateLimitUntilMs = 0;
let rateLimitBackoffMs = DEFAULT_RATE_LIMIT_BACKOFF_MS;

export type TursoPushPriority = "normal" | "completion";

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

function defaultAppsRoot(): string {
  return getPaprAppsRoot();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executePushForJob(
  bridge: TursoSyncBridge,
  syncKey: string,
): Promise<void> {
  if (!(await bridge.isJobLinkedToApp(syncKey))) {
    return;
  }

  const sources = await bridge.listLinkedSources(true);
  const linked = findLinkedSourceForJob(sources, syncKey);
  if (!linked) {
    return;
  }

  if (!(await bridge.linkedSourceNeedsPush(linked))) {
    return;
  }

  try {
    const result = await bridge.pushJob(syncKey);
    if (result.status === "pushed") {
      recordTursoPushSuccess(
        linkedSourceSyncKey(linked),
        linked.dbPath,
        undefined,
        result.tableFingerprints,
      );
      const skipped =
        result.skippedTables && result.skippedTables.length > 0
          ? `, skipped ${result.skippedTables.length} unchanged table(s)`
          : "";
      console.log(
        `[TursoPushScheduler] Pushed ${linkedSourceSyncKey(linked)} (${result.tables.length} table(s)${skipped})`,
      );
      return;
    }

    if (result.reason === "all_tables_unchanged" && result.tableFingerprints) {
      recordTursoPushSuccess(
        linkedSourceSyncKey(linked),
        linked.dbPath,
        undefined,
        result.tableFingerprints,
      );
    }
  } catch (error) {
    const message = (error as Error).message;
    if (
      isTursoLocalDatabaseCorruptError(message) ||
      isTursoSqliteBindTypeError(message)
    ) {
      recordTursoPushQuarantine(linkedSourceSyncKey(linked), linked.dbPath, message);
      return;
    }
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
  if (queuedJobIds.has(jobId)) {
    return;
  }
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
): void {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }

  const existing = jobTimers.get(jobId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    jobTimers.delete(jobId);
    enqueueTursoPush(jobId);
  }, debounceMs(priority));

  jobTimers.set(jobId, timer);
}

export function scheduleTursoPushAllLinked(): void {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }

  if (allLinkedTimer) {
    clearTimeout(allLinkedTimer);
  }

  allLinkedTimer = setTimeout(() => {
    allLinkedTimer = null;
    void enqueueDirtyLinkedJobs(bridge.getAppsRootDir() ?? defaultAppsRoot());
  }, debounceMs("normal"));
}

async function enqueueDirtyLinkedJobs(appsRootDir: string): Promise<void> {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }

  const sources = await discoverTursoLinkedSources(appsRootDir);
  let enqueued = 0;
  for (const source of sources) {
    const syncKey = linkedSourceSyncKey(source);
    if (!(await bridge.linkedSourceNeedsPush(source))) {
      continue;
    }
    enqueueTursoPush(syncKey);
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

  const root = appsRootDir ?? bridge.getAppsRootDir() ?? defaultAppsRoot();
  await enqueueDirtyLinkedJobs(root);
}

/** Test hook — flush queue state between tests. */
export function resetTursoPushQueueForTests(): void {
  for (const timer of jobTimers.values()) {
    clearTimeout(timer);
  }
  jobTimers.clear();
  if (allLinkedTimer) {
    clearTimeout(allLinkedTimer);
    allLinkedTimer = null;
  }
  pushQueue.length = 0;
  queuedJobIds.clear();
  queueProcessing = false;
  rateLimitUntilMs = 0;
  rateLimitBackoffMs = DEFAULT_RATE_LIMIT_BACKOFF_MS;
}
