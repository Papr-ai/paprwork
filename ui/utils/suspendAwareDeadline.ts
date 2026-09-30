/**
 * A deadline that spanned a system suspend proves nothing.
 *
 * `setTimeout` does not fire while the machine is asleep — the renderer is
 * frozen — so an overdue timer fires the moment the lid opens. A request issued
 * within 30s of the lid closing therefore rejects with "Gateway connection
 * timeout" on wake whether or not anything is wrong, because the deadline is
 * measured in wall clock across an interval in which no code could run. Both
 * ends were frozen together, so nothing had a chance to answer.
 *
 * The fix is not a longer timeout: re-arm once the process is running again,
 * and give the deadline the running time it was supposed to measure.
 */

/**
 * Re-arms tolerated before reporting the timeout anyway.
 *
 * Bounded rather than unlimited: a machine that suspends every few seconds
 * would otherwise leave the promise pending forever, and a caller waiting
 * indefinitely is a worse failure than a timeout that is arguably premature.
 */
export const MAX_SUSPEND_REARMS = 2;

/**
 * Excess wall clock, over the intended delay, that indicates the process was
 * not running. Deliberately wide — a loaded renderer can fire a 30s timer a few
 * seconds late, while a suspend is measured in minutes or hours.
 */
export const FROZEN_EXCESS_FLOOR_MS = 10_000;

export interface SuspendSpanInput {
  /** Intended delay, in ms. */
  delayMs: number;
  /** When the deadline was armed (epoch ms). */
  armedAtMs: number;
  /** Now (epoch ms). */
  nowMs: number;
  /** Epoch ms of the most recent `system:resume`, or 0 if none seen. */
  lastResumeAtMs: number;
}

/**
 * Whether this deadline spanned a period in which the process was not running.
 *
 * Two independent signals, because each covers the other's blind spot:
 *
 * - A recorded `system:resume` after the deadline was armed is precise, but the
 *   overdue timer and the resume IPC race on wake, so the event may not have
 *   arrived yet when the timer fires.
 * - Wall clock far exceeding the intended delay is self-evident proof the timer
 *   did not run on schedule, and needs no event at all.
 */
export function deadlineSpannedSuspend(input: SuspendSpanInput): boolean {
  if (input.lastResumeAtMs > input.armedAtMs) {
    return true;
  }
  const elapsed = input.nowMs - input.armedAtMs;
  const allowance =
    input.delayMs + Math.max(input.delayMs, FROZEN_EXCESS_FLOOR_MS);
  return elapsed > allowance;
}

export interface SuspendAwareTimeoutOptions {
  delayMs: number;
  /** Called when the deadline genuinely expires. */
  onExpire: () => void;
  /** Reads the latest recorded resume timestamp at fire time, not at arm time. */
  getLastResumeAtMs: () => number;
  now?: () => number;
  /** Reported once per re-arm, so a bogus timeout leaves a trace either way. */
  onRearm?: (details: { attempt: number; elapsedMs: number }) => void;
}

/**
 * Schedule a deadline that re-arms itself when it spanned a suspend.
 *
 * Returns a cancel function. Safe to cancel more than once.
 */
export function scheduleSuspendAwareTimeout(
  options: SuspendAwareTimeoutOptions,
): () => void {
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let armedAtMs = now();
  let rearms = 0;

  const arm = (): void => {
    timer = setTimeout(() => {
      timer = null;
      const nowMs = now();
      const spanned = deadlineSpannedSuspend({
        delayMs: options.delayMs,
        armedAtMs,
        nowMs,
        lastResumeAtMs: options.getLastResumeAtMs(),
      });

      if (spanned && rearms < MAX_SUSPEND_REARMS) {
        rearms += 1;
        options.onRearm?.({
          attempt: rearms,
          elapsedMs: nowMs - armedAtMs,
        });
        armedAtMs = nowMs;
        arm();
        return;
      }

      options.onExpire();
    }, options.delayMs);
  };

  arm();

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
