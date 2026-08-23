/**
 * Debounced app-repo writer push during cloud agent runs — mirrors Turso debouncer.
 */

import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { finalizeAppRepoMutation } from "../syncV3/finalizeAppRepoMutation.js";

const DEFAULT_DEBOUNCE_MS = 15_000;
const DEFAULT_MAX_WAIT_MS = 120_000;

function debounceMs(): number {
  const raw = process.env.CLOUD_AGENT_WRITER_DEBOUNCE_MS;
  if (!raw) {
    return DEFAULT_DEBOUNCE_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEBOUNCE_MS;
}

function maxWaitMs(): number {
  const raw = process.env.CLOUD_AGENT_WRITER_MAX_WAIT_MS;
  if (!raw) {
    return DEFAULT_MAX_WAIT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_WAIT_MS;
}

export interface CloudAppWriterFlushFailure {
  appId: string;
  error: string;
}

export interface CloudAppWriterFlushResult {
  pushedAppIds: string[];
  failed: CloudAppWriterFlushFailure[];
}

export class CloudAppWriterFlushError extends Error {
  readonly failures: CloudAppWriterFlushFailure[];

  constructor(failures: CloudAppWriterFlushFailure[]) {
    super(
      `Cloud app writer flush failed for ${failures.length} app(s): ${failures
        .map((failure) => `${failure.appId} (${failure.error})`)
        .join("; ")}`,
    );
    this.name = "CloudAppWriterFlushError";
    this.failures = failures;
  }
}

export interface CloudAppWriterDebouncedPushHandle {
  flush(): Promise<CloudAppWriterFlushResult>;
  flushAndStop(): Promise<CloudAppWriterFlushResult>;
  stop(): Promise<void>;
}

let moduleDirtyApps = new Set<string>();
let modulePendingTimer: NodeJS.Timeout | null = null;
let moduleMaxWaitTimer: NodeJS.Timeout | null = null;
let moduleFirstDirtyAtMs: number | null = null;
let moduleFlushInFlight: Promise<CloudAppWriterFlushResult> | null = null;
let moduleStopped = false;
/** Apps successfully pushed during this run (includes mid-run debounced flushes). */
let modulePushedAppIds = new Set<string>();

function clearModuleTimers(): void {
  if (modulePendingTimer) {
    clearTimeout(modulePendingTimer);
    modulePendingTimer = null;
  }
  if (moduleMaxWaitTimer) {
    clearTimeout(moduleMaxWaitTimer);
    moduleMaxWaitTimer = null;
  }
  moduleFirstDirtyAtMs = null;
}

function mergeFlushResults(
  left: CloudAppWriterFlushResult,
  right: CloudAppWriterFlushResult,
): CloudAppWriterFlushResult {
  return {
    pushedAppIds: [...new Set([...left.pushedAppIds, ...right.pushedAppIds])],
    failed: [...left.failed, ...right.failed],
  };
}

function recordPushedApps(appIds: readonly string[]): void {
  for (const appId of appIds) {
    modulePushedAppIds.add(appId);
  }
}

function requeueFailedApps(
  failures: readonly CloudAppWriterFlushFailure[],
): void {
  if (moduleStopped || failures.length === 0) {
    return;
  }
  for (const failure of failures) {
    moduleDirtyApps.add(failure.appId);
  }
  scheduleModuleFlush();
}

/** Queue apps whose flush was truncated by the batch budget. */
function requeueIncompleteApps(appIds: readonly string[]): void {
  if (moduleStopped || appIds.length === 0) {
    return;
  }
  for (const appId of appIds) {
    moduleDirtyApps.add(appId);
  }
  scheduleModuleFlush();
}

async function executeWriterFlush(
  appIds: readonly string[],
): Promise<CloudAppWriterFlushResult> {
  if (appIds.length === 0) {
    return { pushedAppIds: [], failed: [] };
  }

  const paprDir = getPaprRoot();
  const pushedAppIds: string[] = [];
  const failed: CloudAppWriterFlushFailure[] = [];
  const incomplete: string[] = [];

  for (const appId of appIds) {
    try {
      const result = await finalizeAppRepoMutation(paprDir, appId, {
        source: "cloud-sandbox",
        skipCatalog: true,
      });
      if (result.writerPushed) {
        pushedAppIds.push(appId);
        console.log(
          `[CloudAppWriterDebouncedPush] Pushed ${appId}` +
            (result.commitSha ? ` @ ${result.commitSha.slice(0, 8)}` : ""),
        );
      }
      // A flush capped by the batch budget sent only part of the app. Queue it
      // again so the remainder follows instead of waiting for the next edit.
      if (result.deferred > 0) {
        incomplete.push(appId);
        console.log(
          `[CloudAppWriterDebouncedPush] ${appId} has ${result.deferred} ` +
            `file(s) left — re-queued`,
        );
      }
    } catch (error) {
      failed.push({
        appId,
        error: (error as Error).message.slice(0, 200),
      });
    }
  }

  recordPushedApps(pushedAppIds);
  requeueFailedApps(failed);
  requeueIncompleteApps(incomplete);

  return { pushedAppIds, failed };
}

function drainDirtyAppIds(): string[] {
  clearModuleTimers();
  const appIds = [...moduleDirtyApps];
  moduleDirtyApps.clear();
  return appIds;
}

function scheduleModuleFlush(): void {
  if (moduleStopped || moduleDirtyApps.size === 0) {
    return;
  }

  if (moduleFirstDirtyAtMs === null) {
    moduleFirstDirtyAtMs = Date.now();
    moduleMaxWaitTimer = setTimeout(() => {
      moduleMaxWaitTimer = null;
      const appIds = drainDirtyAppIds();
      void flushWriterApps(appIds).catch((error) => {
        console.error(
          "[CloudAppWriterDebouncedPush] Max-wait flush failed:",
          (error as Error).message,
        );
      });
    }, maxWaitMs());
  }

  if (modulePendingTimer) {
    clearTimeout(modulePendingTimer);
  }

  modulePendingTimer = setTimeout(() => {
    modulePendingTimer = null;
    const appIds = drainDirtyAppIds();
    void flushWriterApps(appIds).catch((error) => {
      console.error(
        "[CloudAppWriterDebouncedPush] Debounced flush failed:",
        (error as Error).message,
      );
    });
  }, debounceMs());
}

async function flushWriterApps(
  appIds: readonly string[],
): Promise<CloudAppWriterFlushResult> {
  if (moduleFlushInFlight) {
    const inFlightResult = await moduleFlushInFlight;
    if (appIds.length === 0) {
      return inFlightResult;
    }
  }

  if (appIds.length === 0) {
    return { pushedAppIds: [], failed: [] };
  }

  moduleFlushInFlight = executeWriterFlush(appIds);
  try {
    return await moduleFlushInFlight;
  } finally {
    moduleFlushInFlight = null;
  }
}

/** All apps pushed successfully during the current debouncer session. */
export function getCloudAppWriterPushedAppIds(): string[] {
  return [...modulePushedAppIds];
}

/** Hook from AppService when GATEWAY_MODE=cloud_agent (no desktop SyncCoordinator). */
export function notifyCloudSandboxAppSave(appId: string): void {
  if (process.env.GATEWAY_MODE !== "cloud_agent") {
    return;
  }
  moduleDirtyApps.add(appId);
  scheduleModuleFlush();
}

export async function startCloudAppWriterDebouncedPush(): Promise<CloudAppWriterDebouncedPushHandle> {
  moduleStopped = false;
  modulePushedAppIds.clear();
  console.log(
    `[CloudAppWriterDebouncedPush] Ready debounce=${debounceMs()}ms maxWait=${maxWaitMs()}ms`,
  );

  const handle: CloudAppWriterDebouncedPushHandle = {
    async flush(): Promise<CloudAppWriterFlushResult> {
      const appIds = drainDirtyAppIds();
      return flushWriterApps(appIds);
    },

    async flushAndStop(): Promise<CloudAppWriterFlushResult> {
      const first = await handle.flush();
      moduleStopped = true;
      clearModuleTimers();
      let combined = first;
      if (moduleDirtyApps.size > 0) {
        const second = await flushWriterApps(drainDirtyAppIds());
        combined = mergeFlushResults(first, second);
      }
      return {
        pushedAppIds: getCloudAppWriterPushedAppIds(),
        failed: combined.failed,
      };
    },

    async stop(): Promise<void> {
      moduleStopped = true;
      clearModuleTimers();
    },
  };

  return handle;
}

/** Reset module state between tests. */
export function resetCloudAppWriterDebouncedPushForTests(): void {
  moduleStopped = true;
  clearModuleTimers();
  moduleDirtyApps.clear();
  modulePushedAppIds.clear();
  moduleFlushInFlight = null;
}
