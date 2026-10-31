import type { SqlDatabase } from '@splitin/outreach-contracts';
import type { RatePolicy, Reservation } from './types';

export type ReservationResult =
  | { ok: true; reservations: Reservation[] }
  | { ok: false; retryAt: number; reason: string };

/**
 * Atomically reserves one unit in every fixed window of the policy and enforces the per-recipient gap.
 * All-or-nothing: must run inside the preflight transaction, which rolls back partial reservations.
 */
export function reserveBudget(
  db: SqlDatabase,
  workspaceId: string,
  recipient: string | null,
  policy: RatePolicy,
  now: number,
): ReservationResult {
  if (recipient && policy.recipientMinGapMs && policy.recipientMinGapMs > 0) {
    const last = db
      .prepare(
        `SELECT MAX(at) AS at FROM messages
         WHERE workspace_id = ? AND direction = 'outbound' AND recipient_norm = ?`,
      )
      .get<{ at: number | null }>(workspaceId, recipient);
    if (last?.at != null && now - last.at < policy.recipientMinGapMs) {
      return { ok: false, retryAt: last.at + policy.recipientMinGapMs, reason: 'recipient_min_gap' };
    }
  }

  const reservations: Reservation[] = [];
  for (const limit of policy.limits) {
    const windowStart = Math.floor(now / limit.windowMs) * limit.windowMs;
    const row = db
      .prepare('SELECT used FROM rate_buckets WHERE workspace_id = ? AND scope_key = ? AND window_start = ?')
      .get<{ used: number }>(workspaceId, limit.scopeKey, windowStart);
    if ((row?.used ?? 0) >= limit.limit) {
      return { ok: false, retryAt: windowStart + limit.windowMs, reason: `rate_limit:${limit.scopeKey}` };
    }
    db.prepare(
      `INSERT INTO rate_buckets (workspace_id, scope_key, window_start, used, limit_value) VALUES (?,?,?,1,?)
       ON CONFLICT (workspace_id, scope_key, window_start)
       DO UPDATE SET used = used + 1, limit_value = excluded.limit_value`,
    ).run(workspaceId, limit.scopeKey, windowStart, limit.limit);
    reservations.push({ scopeKey: limit.scopeKey, windowStart });
  }
  return { ok: true, reservations };
}

/** Gives back reservations for an attempt the provider confirmed did not happen. */
export function releaseBudget(db: SqlDatabase, workspaceId: string, reservations: readonly Reservation[]): void {
  for (const reservation of reservations) {
    db.prepare(
      `UPDATE rate_buckets SET used = MAX(used - 1, 0)
       WHERE workspace_id = ? AND scope_key = ? AND window_start = ?`,
    ).run(workspaceId, reservation.scopeKey, reservation.windowStart);
  }
}
