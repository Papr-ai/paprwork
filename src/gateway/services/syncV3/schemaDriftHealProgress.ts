/**
 * Stop the drift heal re-shipping work that never changes.
 *
 * The heal measures drift, ships schema entries and measures again on the next
 * pass. That converges only if shipping changes something. When it does not —
 * the remote rejects the statements, or is not ours to write to — the same
 * payload goes out every ~20s indefinitely, which is the shape the `books`
 * database was observed in: nine identical migration ids and seven identical
 * heal ops, re-shipped on every pass for hours.
 *
 * Shipping reports how many entries were *sent*, never how many were applied,
 * so success cannot be used as the progress signal. What can is the work
 * itself: the heal caps rebuilds at one per pass, so a database that is
 * genuinely converging produces different work each time. An unchanged
 * signature across several passes therefore means nothing moved.
 */

import { createHash } from "crypto";
import type { JobMigrationSchemaOp } from "../../../core/types/jobMigrations.js";

/**
 * Identical passes tolerated before parking.
 *
 * Above one so a single slow remote apply is not mistaken for a stall — the
 * memory server applies asynchronously, so the pass right after a ship can
 * legitimately still see the old schema.
 */
export const MAX_UNCHANGED_HEAL_PASSES = 3;

/** How long a parked database waits before re-measuring. */
export const PARKED_RECHECK_INTERVAL_MS = 10 * 60 * 1000;

export function driftHealWorkSignature(work: {
  unsatisfied: readonly string[];
  healOps: readonly JobMigrationSchemaOp[];
}): string {
  // Sorted: the ledger read order is not guaranteed stable, and an ordering
  // difference is not progress.
  const migrations = [...work.unsatisfied].sort();
  // Hash the ops, never the shipped payload: the heal payload's migrationId
  // embeds Date.now(), so its content hash differs on every pass even when
  // the statements are byte-identical.
  //
  // Serialized over the op's own keys rather than per-kind, so a kind this
  // function has not been taught about still contributes. Naming the kinds
  // individually would collapse an unhandled one to a constant, and two
  // different payloads reading as identical is a park that should not happen.
  const ops = work.healOps.map((op) => {
    const entries = Object.entries(op as Record<string, unknown>)
      .map(([key, value]) => [key, String(value)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([key, value]) => `${key}=${value}`).join("\u0000");
  });
  return createHash("sha256")
    .update(JSON.stringify({ migrations, ops }))
    .digest("hex")
    .slice(0, 16);
}

interface HealProgressState {
  signature: string;
  unchangedPasses: number;
  parkedAt: number | null;
}

const stateBySyncKey = new Map<string, HealProgressState>();

export interface DriftHealPassGate {
  /** False when parked and not yet due for a re-measure. */
  proceed: boolean;
  /** Set when skipping, for the caller's log line. */
  reason?: string;
}

/**
 * Checked before the remote work, which is the expensive part (a drift scan
 * over every syncable table plus a ledger read per migration). A parked
 * database still re-measures periodically so a remote that starts accepting
 * the statements is noticed without a restart.
 */
export function beginDriftHealPass(
  syncKey: string,
  now: number = Date.now(),
): DriftHealPassGate {
  const state = stateBySyncKey.get(syncKey);
  if (!state?.parkedAt) {
    return { proceed: true };
  }
  const elapsed = now - state.parkedAt;
  if (elapsed < PARKED_RECHECK_INTERVAL_MS) {
    const waitMs = PARKED_RECHECK_INTERVAL_MS - elapsed;
    return {
      proceed: false,
      reason: `parked after ${state.unchangedPasses} unchanged passes — re-measuring in ${Math.ceil(waitMs / 1000)}s`,
    };
  }
  return { proceed: true };
}

export interface DriftHealShipDecision {
  ship: boolean;
  unchangedPasses: number;
  /** True on the pass that parks it — the caller logs the stuck set once. */
  justParked: boolean;
  /** True when work changed while parked, so the heal resumes. */
  resumed: boolean;
}

/**
 * Recorded after the work is measured and before it is shipped.
 *
 * Any change in the work resets the counter and unparks: that is the only
 * evidence of progress available, and treating it as such means a remote that
 * heals one table at a time is never mistaken for a stall.
 */
export function recordDriftHealWork(
  syncKey: string,
  signature: string,
  now: number = Date.now(),
): DriftHealShipDecision {
  const state = stateBySyncKey.get(syncKey);

  if (!state || state.signature !== signature) {
    stateBySyncKey.set(syncKey, {
      signature,
      unchangedPasses: 1,
      parkedAt: null,
    });
    return {
      ship: true,
      unchangedPasses: 1,
      justParked: false,
      resumed: Boolean(state?.parkedAt),
    };
  }

  const unchangedPasses = state.unchangedPasses + 1;

  if (state.parkedAt) {
    // Re-measured while parked and nothing changed. Stay parked and restart
    // the interval rather than logging the same stuck set every 10 minutes.
    stateBySyncKey.set(syncKey, { signature, unchangedPasses, parkedAt: now });
    return { ship: false, unchangedPasses, justParked: false, resumed: false };
  }

  if (unchangedPasses > MAX_UNCHANGED_HEAL_PASSES) {
    stateBySyncKey.set(syncKey, { signature, unchangedPasses, parkedAt: now });
    return { ship: false, unchangedPasses, justParked: true, resumed: false };
  }

  stateBySyncKey.set(syncKey, { signature, unchangedPasses, parkedAt: null });
  return { ship: true, unchangedPasses, justParked: false, resumed: false };
}

/** Converged: drop the state so a later drift starts from a clean count. */
export function clearDriftHealProgress(syncKey: string): void {
  stateBySyncKey.delete(syncKey);
}

export function resetDriftHealProgressForTests(): void {
  stateBySyncKey.clear();
}
