/**
 * Per-stream and process-level memory thresholds for pi-ai tool loops.
 */

/** Max heap growth attributable to a single stream before graceful abort. */
export const PI_STREAM_MEMORY_BUDGET_BYTES = 400 * 1024 * 1024;

/** Warn when a single stream exceeds this delta. */
export const PI_STREAM_MEMORY_WARNING_BYTES = 300 * 1024 * 1024;

/** Absolute process heap backstop — last resort before OS pressure. */
export const PI_PROCESS_MEMORY_BACKSTOP_BYTES = 2.5 * 1024 * 1024 * 1024;

export interface PiStreamMemoryCheck {
  heapUsed: number;
  streamDelta: number;
  overStreamBudget: boolean;
  overProcessBackstop: boolean;
  overStreamWarning: boolean;
}

export function checkPiStreamMemory(
  baselineHeap: number,
  heapUsed = process.memoryUsage().heapUsed,
): PiStreamMemoryCheck {
  const streamDelta = Math.max(0, heapUsed - baselineHeap);
  return {
    heapUsed,
    streamDelta,
    overStreamBudget: streamDelta > PI_STREAM_MEMORY_BUDGET_BYTES,
    overProcessBackstop: heapUsed > PI_PROCESS_MEMORY_BACKSTOP_BYTES,
    overStreamWarning: streamDelta > PI_STREAM_MEMORY_WARNING_BYTES,
  };
}
