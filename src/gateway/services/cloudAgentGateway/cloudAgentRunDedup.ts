import { isCloudAppAgentWarmSession } from "./cloudAppAgentSession.js";
import type { CloudAgentRunRequest, CloudAgentRunResponse } from "./types.js";

const COMPLETED_TTL_MS = 30 * 60 * 1000;

interface DedupSlot {
  promise: Promise<CloudAgentRunResponse>;
  completed?: CloudAgentRunResponse;
  completedAt?: number;
}

const slots = new Map<string, DedupSlot>();

/** Reset in tests only. */
export function resetCloudAgentRunDedupForTests(): void {
  slots.clear();
}

/**
 * One-shot cloud jobs (scheduler / job-run). Warm app-agent turns are excluded —
 * each user message is an intentional new turn.
 */
export function buildCloudAgentRunDedupKey(
  request: CloudAgentRunRequest,
): string | null {
  if (isCloudAppAgentWarmSession(request)) {
    return null;
  }

  const namespaceId = request.namespaceId?.trim() ?? "";
  const base = `${request.orgId}:${namespaceId}:${request.userId}:${request.jobId}`;

  const scheduledDueAt = request.scheduledDueAt?.trim();
  if (scheduledDueAt) {
    return `sched:${base}:${scheduledDueAt}`;
  }

  return `run:${base}:${request.runId}`;
}

function pruneExpiredCompleted(key: string, slot: DedupSlot): void {
  if (
    slot.completed &&
    slot.completedAt !== undefined &&
    Date.now() - slot.completedAt > COMPLETED_TTL_MS
  ) {
    slots.delete(key);
  }
}

export function getCachedCloudAgentRunResult(
  request: CloudAgentRunRequest,
): CloudAgentRunResponse | undefined {
  const key = buildCloudAgentRunDedupKey(request);
  if (!key) {
    return undefined;
  }
  return getCachedResult(key);
}

function getCachedResult(key: string): CloudAgentRunResponse | undefined {
  const slot = slots.get(key);
  if (!slot?.completed || slot.completedAt === undefined) {
    return undefined;
  }
  if (Date.now() - slot.completedAt > COMPLETED_TTL_MS) {
    slots.delete(key);
    return undefined;
  }
  return slot.completed;
}

/**
 * Coalesce duplicate scheduler dispatches and gateway retries onto one execution.
 */
export async function runWithCloudAgentRunDedup(
  request: CloudAgentRunRequest,
  execute: () => Promise<CloudAgentRunResponse>,
): Promise<CloudAgentRunResponse> {
  const key = buildCloudAgentRunDedupKey(request);
  if (!key) {
    return execute();
  }

  const cached = getCachedResult(key);
  if (cached) {
    console.log(
      `[CloudAgentRunDedup] Returning cached scheduled run key=${key} chatId=${cached.chatId}`,
    );
    return cached;
  }

  let slot = slots.get(key);
  if (slot) {
    pruneExpiredCompleted(key, slot);
    slot = slots.get(key);
  }

  if (slot?.promise) {
    console.log(`[CloudAgentRunDedup] Coalescing in-flight run key=${key}`);
    return slot.promise;
  }

  const promise = execute()
    .then((result) => {
      if (result.exitCode === 0) {
        slots.set(key, {
          promise: Promise.resolve(result),
          completed: result,
          completedAt: Date.now(),
        });
      } else {
        slots.delete(key);
      }
      return result;
    })
    .catch((error) => {
      slots.delete(key);
      throw error;
    });

  slots.set(key, { promise });
  return promise;
}

export class CloudAgentRunDuplicateInFlightError extends Error {
  readonly code = "duplicate_scheduled_run" as const;

  constructor(message = "A cloud agent run for this scheduled slot is already in progress") {
    super(message);
    this.name = "CloudAgentRunDuplicateInFlightError";
  }
}

/**
 * Register an in-flight one-shot stream before work starts so a second POST cannot
 * spawn a parallel agent (same slot / runId).
 */
export function beginCloudAgentOneShotStreamDedup(
  request: CloudAgentRunRequest,
): { release: (result: CloudAgentRunResponse) => void } {
  const key = buildCloudAgentRunDedupKey(request);
  if (!key) {
    return { release: () => {} };
  }

  let slot = slots.get(key);
  if (slot?.promise) {
    throw new CloudAgentRunDuplicateInFlightError();
  }

  let resolveInflight!: (result: CloudAgentRunResponse) => void;
  const promise = new Promise<CloudAgentRunResponse>((resolve) => {
    resolveInflight = resolve;
  });

  slots.set(key, { promise });

  return {
    release: (result: CloudAgentRunResponse) => {
      resolveInflight(result);
      if (result.exitCode === 0) {
        slots.set(key, {
          promise: Promise.resolve(result),
          completed: result,
          completedAt: Date.now(),
        });
      } else {
        slots.delete(key);
      }
    },
  };
}
