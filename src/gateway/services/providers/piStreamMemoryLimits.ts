/**
 * Per-stream and process-level memory thresholds for pi-ai tool loops.
 *
 * Why these are dynamic
 * ─────────────────────
 * The previous constants were flat: 400 MB stream budget, 2.5 GB process
 * backstop. Two problems with that:
 *
 *  1. **They ignored the machine.** V8's actual ceiling comes from
 *     `--max-old-space-size` (default ~4 GB on 64-bit). A 2.5 GB backstop is
 *     conservative on a 64 GB workstation and roughly right on a 16 GB laptop.
 *     Users doing legitimate data-migration work hit an artificial wall that
 *     had nothing to do with their available RAM.
 *
 *  2. **They measured the wrong thing.** `streamDelta` counts *all* heap growth
 *     during a stream, including garbage that has not been collected yet. A
 *     single turn that buffers several large tool results trips the breaker
 *     even though the retained set is small. We now force a GC opportunity
 *     before declaring exhaustion, so we abort on *retained* heap rather than
 *     on allocation churn.
 *
 * The budget scales off the real V8 heap ceiling rather than `os.totalmem()`,
 * because V8 will OOM at its own limit regardless of how much RAM the box has.
 * Raising RAM alone does NOT raise the ceiling — the process must also be
 * started with a larger `--max-old-space-size`.
 */

import v8 from "node:v8";

/** Fraction of the V8 heap ceiling a single stream may consume. */
const STREAM_BUDGET_HEAP_FRACTION = 0.35;
/** Fraction of the V8 heap ceiling at which we stop everything. */
const PROCESS_BACKSTOP_HEAP_FRACTION = 0.8;

/** Floors so small/misreported heaps still get a usable budget. */
const MIN_STREAM_BUDGET_BYTES = 400 * 1024 * 1024;
const MIN_PROCESS_BACKSTOP_BYTES = 2.5 * 1024 * 1024 * 1024;

/** Ceilings so a huge heap ceiling doesn't let one stream starve the app. */
const MAX_STREAM_BUDGET_BYTES = 3 * 1024 * 1024 * 1024;

function heapCeilingBytes(): number {
  try {
    const limit = v8.getHeapStatistics().heap_size_limit;
    return Number.isFinite(limit) && limit > 0 ? limit : 4 * 1024 * 1024 * 1024;
  } catch {
    return 4 * 1024 * 1024 * 1024;
  }
}

function envOverrideBytes(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const mb = Number(raw);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : null;
}

/** Max heap growth attributable to a single stream before graceful abort. */
export function getPiStreamMemoryBudgetBytes(): number {
  return (
    envOverrideBytes("PAPR_STREAM_MEMORY_BUDGET_MB") ??
    Math.min(
      MAX_STREAM_BUDGET_BYTES,
      Math.max(
        MIN_STREAM_BUDGET_BYTES,
        Math.floor(heapCeilingBytes() * STREAM_BUDGET_HEAP_FRACTION),
      ),
    )
  );
}

/** Absolute process heap backstop — last resort before OS pressure. */
export function getPiProcessBackstopBytes(): number {
  return (
    envOverrideBytes("PAPR_PROCESS_MEMORY_BACKSTOP_MB") ??
    Math.max(
      MIN_PROCESS_BACKSTOP_BYTES,
      Math.floor(heapCeilingBytes() * PROCESS_BACKSTOP_HEAP_FRACTION),
    )
  );
}

/** Warn when a single stream exceeds 75% of its budget. */
export function getPiStreamMemoryWarningBytes(): number {
  return Math.floor(getPiStreamMemoryBudgetBytes() * 0.75);
}

// Back-compat named exports (evaluated once at module load).
export const PI_STREAM_MEMORY_BUDGET_BYTES = getPiStreamMemoryBudgetBytes();
export const PI_STREAM_MEMORY_WARNING_BYTES = getPiStreamMemoryWarningBytes();
export const PI_PROCESS_MEMORY_BACKSTOP_BYTES = getPiProcessBackstopBytes();

export interface PiStreamMemoryCheck {
  heapUsed: number;
  streamDelta: number;
  overStreamBudget: boolean;
  overProcessBackstop: boolean;
  overStreamWarning: boolean;
  /** Budget in force for this check — include in telemetry and error text. */
  streamBudget: number;
  /** True when the verdict was reached after a forced GC (retained, not churn). */
  confirmedAfterGc: boolean;
}

/**
 * Ask V8 to collect garbage, if the runtime exposes it.
 *
 * Electron's main process is typically started with `--expose-gc` internally;
 * when it isn't, `v8.setFlagsFromString` + `vm.runInNewContext` is the standard
 * fallback. Both are best-effort — we never fail a stream because GC is absent.
 */
function tryForceGc(): boolean {
  const globalGc = (globalThis as { gc?: () => void }).gc;
  if (typeof globalGc === "function") {
    try {
      globalGc();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function checkPiStreamMemory(
  baselineHeap: number,
  heapUsed = process.memoryUsage().heapUsed,
): PiStreamMemoryCheck {
  const streamBudget = getPiStreamMemoryBudgetBytes();
  const backstop = getPiProcessBackstopBytes();
  const warning = getPiStreamMemoryWarningBytes();

  let effectiveHeap = heapUsed;
  let confirmedAfterGc = false;

  const provisionalDelta = Math.max(0, effectiveHeap - baselineHeap);

  // Only pay for a GC when we are about to abort. Uncollected garbage from
  // large tool results is the single most common false positive here.
  if (provisionalDelta > streamBudget || effectiveHeap > backstop) {
    if (tryForceGc()) {
      effectiveHeap = process.memoryUsage().heapUsed;
      confirmedAfterGc = true;
    }
  }

  const streamDelta = Math.max(0, effectiveHeap - baselineHeap);
  return {
    heapUsed: effectiveHeap,
    streamDelta,
    overStreamBudget: streamDelta > streamBudget,
    overProcessBackstop: effectiveHeap > backstop,
    overStreamWarning: streamDelta > warning,
    streamBudget,
    confirmedAfterGc,
  };
}

/** Human-readable limits for error messages and diagnostics. */
export function describePiStreamMemoryLimits(): string {
  const toMb = (n: number): number => Math.round(n / 1048576);
  return (
    `stream budget ${toMb(getPiStreamMemoryBudgetBytes())} MB, ` +
    `process backstop ${toMb(getPiProcessBackstopBytes())} MB, ` +
    `V8 heap ceiling ${toMb(heapCeilingBytes())} MB`
  );
}
