/**
 * Defers heavy gateway background work (vault sync, billing resume, code index batches)
 * until the interactive hot path is quiet and event-loop lag is acceptable.
 */

import {
  isInteractiveHotPathBusy,
  waitForInteractiveQuietBeforeBackgroundWork,
  type WaitForInteractiveQuietOptions,
} from "./gatewayInteractivePriority.js";
import { sampleEventLoopLagMs } from "./gatewayEventLoopMonitor.js";
import {
  GATEWAY_BACKGROUND_CHILD_TASKS,
  isGatewayBackgroundProcessEnabled,
  resolveGatewayBackgroundMaxConcurrency,
} from "./gatewayBackgroundConcurrency.js";

interface CoalescedTaskState {
  inFlight: boolean;
  rerunPending: boolean;
  run: () => Promise<void>;
}

const coalescedTasks = new Map<string, CoalescedTaskState>();

export interface BackgroundTaskTimingRecord {
  taskKey: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

const MAX_TIMING_RECORDS = 64;
const DEFAULT_SLOW_BACKGROUND_TELEMETRY_MS = 10_000;
const recentTaskTimings: BackgroundTaskTimingRecord[] = [];

/** Threshold for opt-in paprwork_slow_operation from coalesced background tasks. */
export function resolveSlowBackgroundTelemetryThresholdMs(): number {
  const raw = process.env.GATEWAY_BG_SLOW_TELEMETRY_MS?.trim();
  if (!raw) {
    return DEFAULT_SLOW_BACKGROUND_TELEMETRY_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SLOW_BACKGROUND_TELEMETRY_MS;
}

function maybeReportSlowBackgroundTaskTelemetry(
  taskKey: string,
  durationMs: number,
  ok: boolean,
): void {
  const thresholdMs = resolveSlowBackgroundTelemetryThresholdMs();
  if (durationMs < thresholdMs) {
    return;
  }
  const operationName = ok ? taskKey : `${taskKey}:failed`;
  void import("./gatewayTelemetry.js").then(({ getGatewayTelemetry }) => {
    void import("../../core/telemetry/events.js").then(({ AmplitudeEvents }) => {
      getGatewayTelemetry().trackFireAndForget(AmplitudeEvents.SLOW_OPERATION, {
        operation_name: operationName.slice(0, 200),
        duration_ms: Math.round(durationMs),
        threshold_ms: thresholdMs,
      });
    });
  });
}

let backgroundSlotsInUse = 0;
const backgroundSlotWaiters: Array<() => void> = [];

async function acquireBackgroundSlot(): Promise<void> {
  const max = resolveGatewayBackgroundMaxConcurrency();
  while (backgroundSlotsInUse >= max) {
    await new Promise<void>((resolve) => {
      backgroundSlotWaiters.push(resolve);
    });
  }
  backgroundSlotsInUse += 1;
}

function releaseBackgroundSlot(): void {
  backgroundSlotsInUse = Math.max(0, backgroundSlotsInUse - 1);
  const next = backgroundSlotWaiters.shift();
  if (next) {
    next();
  }
}

function readEnvMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** True when heavy background work should wait (chat/apps active or gateway lagging). */
export async function isHeavyBackgroundWorkDeferred(): Promise<boolean> {
  if (await isInteractiveHotPathBusy()) {
    return true;
  }
  const lagThresholdMs = readEnvMs("GATEWAY_BG_DEFER_EVENT_LOOP_MS", 1500);
  return sampleEventLoopLagMs(false) >= lagThresholdMs;
}

/** Wait until interactive work is quiet (bounded wait — see gatewayInteractivePriority). */
export async function yieldToInteractiveHotPath(
  label: string,
  quietOptions?: WaitForInteractiveQuietOptions,
): Promise<void> {
  await waitForInteractiveQuietBeforeBackgroundWork(label, {
    minQuietMs: readEnvMs("GATEWAY_BG_QUIET_MS", 1500),
    maxWaitMs: readEnvMs("GATEWAY_BG_MAX_WAIT_MS", 120_000),
    pollMs: 250,
    ...quietOptions,
  });
}

/**
 * Schedule work keyed by taskKey. Concurrent schedules coalesce to one run; a second
 * schedule while in-flight sets rerunPending.
 */
export function scheduleCoalescedBackgroundWork(
  taskKey: string,
  work: () => Promise<void>,
): void {
  let state = coalescedTasks.get(taskKey);
  if (!state) {
    state = { inFlight: false, rerunPending: false, run: work };
    coalescedTasks.set(taskKey, state);
  } else {
    state.run = work;
  }

  if (state.inFlight) {
    state.rerunPending = true;
    return;
  }

  void executeCoalescedTask(taskKey, state);
}

async function runCoalescedTaskBody(
  taskKey: string,
  state: CoalescedTaskState,
): Promise<void> {
  const useChild =
    isGatewayBackgroundProcessEnabled() &&
    GATEWAY_BACKGROUND_CHILD_TASKS.has(taskKey);

  if (useChild) {
    const { getGatewayBackgroundWorkerClient } = await import(
      "./GatewayBackgroundWorkerClient.js"
    );
    await getGatewayBackgroundWorkerClient().runTask(taskKey);
    return;
  }

  await state.run();
}

function recordBackgroundTaskTiming(
  taskKey: string,
  startedAtMs: number,
  ok: boolean,
  error?: string,
): void {
  const finishedAtMs = Date.now();
  recentTaskTimings.push({
    taskKey,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    ok,
    error,
  });
  if (recentTaskTimings.length > MAX_TIMING_RECORDS) {
    recentTaskTimings.splice(0, recentTaskTimings.length - MAX_TIMING_RECORDS);
  }
  maybeReportSlowBackgroundTaskTelemetry(taskKey, finishedAtMs - startedAtMs, ok);
}

/** Recent coalesced background task runs (newest last). */
export function getRecentBackgroundTaskTimings(): BackgroundTaskTimingRecord[] {
  return [...recentTaskTimings];
}

/** True while a coalesced task (e.g. vault:workspace-switch) is executing. */
export function isCoalescedBackgroundTaskInFlight(taskKey: string): boolean {
  const state = coalescedTasks.get(taskKey);
  return state?.inFlight ?? false;
}

export function clearBackgroundTaskTimingsForTests(): void {
  recentTaskTimings.length = 0;
}

async function executeCoalescedTask(
  taskKey: string,
  state: CoalescedTaskState,
): Promise<void> {
  state.inFlight = true;
  try {
    do {
      state.rerunPending = false;
      await acquireBackgroundSlot();
      const runStartedAt = Date.now();
      try {
        await yieldToInteractiveHotPath(taskKey);
        await runCoalescedTaskBody(taskKey, state);
        recordBackgroundTaskTiming(taskKey, runStartedAt, true);
        console.log(
          `[GatewayBackground] ${taskKey} finished in ${Date.now() - runStartedAt}ms`,
        );
      } catch (runErr) {
        const message =
          runErr instanceof Error ? runErr.message : String(runErr);
        recordBackgroundTaskTiming(taskKey, runStartedAt, false, message);
        throw runErr;
      } finally {
        releaseBackgroundSlot();
      }
    } while (state.rerunPending);
  } catch (err) {
    console.warn(
      `[GatewayBackground] ${taskKey} failed:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    state.inFlight = false;
    if (state.rerunPending) {
      state.rerunPending = false;
      void executeCoalescedTask(taskKey, state);
    } else {
      coalescedTasks.delete(taskKey);
    }
  }
}

/** Test helper — reset coalesced task state. */
export function resetCoalescedBackgroundWorkForTests(): void {
  coalescedTasks.clear();
  backgroundSlotsInUse = 0;
  backgroundSlotWaiters.length = 0;
}
