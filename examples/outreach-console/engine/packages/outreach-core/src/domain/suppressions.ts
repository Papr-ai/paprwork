import { hmacSha256Hex, safeEqualHex, sha256Hex, ulid, type SqlDatabase } from '@splitin/outreach-contracts';
import { CANCELLABLE_ACTION_STATES } from '@splitin/outreach-contracts';
import { transitionAction, type Actor } from '../execution/actions-repo';
import type { ActionRow } from '../execution/types';
import type { EnrollmentRow } from './env';

export type SuppressionScope = 'global' | 'channel' | 'provider_account' | 'domain';
export type SuppressionReason = 'opt_out' | 'hard_bounce' | 'complaint' | 'manual' | 'do_not_contact' | 'legal';

export interface SuppressionInput {
  readonly workspaceId: string;
  readonly scope: SuppressionScope;
  /** Channel name for 'channel' scope, provider account id for 'provider_account', '*' otherwise. */
  readonly channel?: string;
  readonly value: string;
  readonly reason: SuppressionReason;
  readonly source: string;
}

export function normalizeEmail(value: string): string {
  return value.trim().replace(/^mailto:/i, '').toLowerCase();
}

/** Idempotent: suppressing an already-suppressed value keeps the earliest record. Must run in a transaction. */
export function addSuppression(db: SqlDatabase, input: SuppressionInput, now: number): void {
  db.prepare(
    `INSERT INTO suppressions (id, workspace_id, scope, channel, value_norm, reason, source, effective_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (workspace_id, scope, channel, value_norm) DO NOTHING`,
  ).run(ulid(now), input.workspaceId, input.scope, input.channel ?? '*', normalizeEmail(input.value), input.reason, input.source, now);
}

/** Checks every scope that can cover an email recipient: global, email channel, sending account and domain. */
export function isSuppressed(db: SqlDatabase, workspaceId: string, recipient: string, providerAccountId: string | null): string | null {
  const value = normalizeEmail(recipient);
  const domain = value.split('@')[1] ?? '';
  const row = db
    .prepare(
      `SELECT scope, reason FROM suppressions WHERE workspace_id = ? AND (
         (scope = 'global' AND value_norm = ?) OR
         (scope = 'channel' AND channel IN ('email','*') AND value_norm = ?) OR
         (scope = 'provider_account' AND channel = ? AND value_norm = ?) OR
         (scope = 'domain' AND value_norm = ?)
       ) LIMIT 1`,
    )
    .get<{ scope: string; reason: string }>(workspaceId, value, value, providerAccountId ?? '', value, domain);
  if (row) return `${row.scope}:${row.reason}`;
  const fingerprint = db.prepare("SELECT reason FROM suppression_fingerprints WHERE workspace_id = ? AND scheme = 'sha256-email-v1' AND digest = ?")
    .get<{ reason: string }>(workspaceId, sha256Hex(value));
  return fingerprint ? `global:${fingerprint.reason}` : null;
}

type StopStatus = 'replied' | 'opted_out' | 'bounced' | 'completed' | 'stopped' | 'error';

/**
 * Stops an enrollment atomically: status change plus cancellation of every pending action and open task.
 * `executing` and `uncertain` actions cannot be recalled (ADR 0002). Returns false if it was not live.
 */
export function stopEnrollment(
  db: SqlDatabase,
  enrollmentId: string,
  status: StopStatus,
  reason: string,
  actor: Actor,
  now: number,
): boolean {
  const changed = db
    .prepare(
      `UPDATE enrollments SET status = ?, stop_reason = ?, row_version = row_version + 1, updated_at = ?
       WHERE id = ? AND status IN ('active','paused')`,
    )
    .run(status, reason, now, enrollmentId);
  if (changed.changes !== 1) return false;
  const placeholders = CANCELLABLE_ACTION_STATES.map(() => '?').join(',');
  const pending = db
    .prepare(`SELECT * FROM scheduled_actions WHERE enrollment_id = ? AND state IN (${placeholders})`)
    .all<ActionRow>(enrollmentId, ...CANCELLABLE_ACTION_STATES);
  for (const action of pending) {
    transitionAction(db, action, 'cancelled', now, actor, { lease_owner: null, lease_expires_at: null, state_reason: `enrollment_${status}` });
  }
  db.prepare(`UPDATE manual_tasks SET status = 'expired', note = ? WHERE enrollment_id = ? AND status = 'open'`).run(`enrollment_${status}`, enrollmentId);
  return true;
}

export function liveEnrollmentsForContact(db: SqlDatabase, workspaceId: string, contactId: string): EnrollmentRow[] {
  return db
    .prepare(`SELECT * FROM enrollments WHERE workspace_id = ? AND contact_id = ? AND status IN ('active','paused')`)
    .all<EnrollmentRow>(workspaceId, contactId);
}

export interface UnsubscribeClaims {
  readonly w: string;
  readonly cp: string;
  readonly c: string;
}

/** Self-verifying token: base64url(claims).hmac — no database lookup is needed to validate it. */
export function createUnsubscribeToken(secret: string, claims: UnsubscribeClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${hmacSha256Hex(secret, body)}`;
}

export function verifyUnsubscribeToken(secret: string, token: string): UnsubscribeClaims | null {
  const [body, signature] = token.split('.');
  if (!body || !signature || !safeEqualHex(hmacSha256Hex(secret, body), signature)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<UnsubscribeClaims>;
    return typeof claims.w === 'string' && typeof claims.cp === 'string' && typeof claims.c === 'string'
      ? { w: claims.w, cp: claims.cp, c: claims.c }
      : null;
  } catch {
    return null;
  }
}
