import {
  ERROR_DISPOSITIONS,
  ulid,
  type ErrorClass,
  type ErrorEffect,
  type ProviderReceipt,
  type SendResult,
  type SqlDatabase,
} from '@splitin/outreach-contracts';
import { loadAction, transitionAction, type Actor } from './actions-repo';
import type { EmailPayload, ManualPayload } from './invoke';
import { setKillSwitch } from './kill-switches';
import { releaseBudget } from './rate';
import { resolveConfig, type ActionRow, type ExecutionDeps, type Reservation } from './types';

interface AttemptRow {
  id: string;
  outcome: string;
  reservations: string;
}

const CLEAR_LEASE = { lease_owner: null, lease_expires_at: null } as const;

function finishAttempt(
  db: SqlDatabase,
  attemptId: string,
  outcome: string,
  now: number,
  extra: { receipt?: ProviderReceipt | null; errorClass?: string | null; detail?: string | null } = {},
): void {
  db.prepare(
    `UPDATE action_attempts SET outcome = ?, finished_at = ?, receipt = ?, error_class = ?, error_detail = ?
     WHERE id = ?`,
  ).run(
    outcome,
    now,
    extra.receipt ? JSON.stringify(extra.receipt) : null,
    extra.errorClass ?? null,
    extra.detail ? extra.detail.slice(0, 300) : null,
    attemptId,
  );
}

export function backoffMs(deps: ExecutionDeps, attemptNo: number, retryAfterMs?: number): number {
  const config = resolveConfig(deps);
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, config.backoffMaxMs);
  const ceiling = Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** Math.max(0, attemptNo - 1));
  return Math.max(1_000, Math.floor((deps.random ?? Math.random)() * ceiling));
}

function recordOutbound(db: SqlDatabase, action: ActionRow, receipt: ProviderReceipt, now: number): void {
  if (action.kind !== 'email.send' && action.kind !== 'email.reply') return;
  if (!action.provider_account_id) return;
  const payload = JSON.parse(action.payload) as EmailPayload;
  db.prepare(
    `INSERT INTO messages (id, workspace_id, direction, provider_account_id, provider_message_id, provider_thread_id,
       rfc_message_id, in_reply_to, references_ids, from_addr, to_addrs, recipient_norm, subject, at, action_id,
       enrollment_id)
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider_account_id, provider_message_id) DO NOTHING`,
  ).run(
    ulid(now),
    action.workspace_id,
    action.provider_account_id,
    receipt.providerMessageId,
    receipt.providerThreadId ?? null,
    receipt.rfcMessageId ?? action.rfc_message_id,
    payload.inReplyTo ?? null,
    JSON.stringify(payload.references ?? []),
    payload.from.address,
    JSON.stringify(payload.to.map((to) => to.address)),
    action.recipient_norm,
    payload.subject,
    receipt.acceptedAt,
    action.id,
    action.enrollment_id,
  );
}

function recordManualTask(db: SqlDatabase, action: ActionRow, now: number): void {
  if (action.kind !== 'manual.task') return;
  const payload = JSON.parse(action.payload) as ManualPayload;
  db.prepare(
    `INSERT INTO manual_tasks (id, workspace_id, action_id, enrollment_id, channel, target_url, draft_text, status,
       created_at) VALUES (?,?,?,?,?,?,?,'open',?) ON CONFLICT (action_id) DO NOTHING`,
  ).run(ulid(now), action.workspace_id, action.id, action.enrollment_id, payload.channel, payload.targetUrl ?? null,
    payload.draft, now);
}

/** Records a confirmed effect. `action` must be `executing` or `reconciling`. */
export function completeSuccess(
  deps: ExecutionDeps,
  action: ActionRow,
  attemptId: string,
  receipt: ProviderReceipt,
  now: number,
  actor: Actor,
): void {
  finishAttempt(deps.db, attemptId, 'succeeded', now, { receipt });
  const done = transitionAction(deps.db, action, 'succeeded', now, actor, { ...CLEAR_LEASE, state_reason: null });
  recordOutbound(deps.db, done, receipt, now);
  recordManualTask(deps.db, done, now);
  deps.effects?.onSucceeded?.(deps.db, done, action.kind === 'manual.task' ? null : receipt, now);
}

/** The provider affirmed nothing was sent: give the budget back and retry if attempts remain. */
export function confirmAbsent(
  deps: ExecutionDeps,
  action: ActionRow,
  attempt: AttemptRow,
  now: number,
  actor: Actor,
): void {
  finishAttempt(deps.db, attempt.id, 'confirmed_absent', now);
  releaseBudget(deps.db, action.workspace_id, JSON.parse(attempt.reservations) as Reservation[]);
  if (action.attempt_count >= action.max_attempts) {
    const failed = transitionAction(deps.db, action, 'failed', now, actor, { ...CLEAR_LEASE, state_reason: 'max_attempts' });
    deps.effects?.onFailed?.(deps.db, failed, null, now);
    return;
  }
  transitionAction(deps.db, action, 'scheduled', now, actor, { ...CLEAR_LEASE, due_at: now, state_reason: 'confirmed_absent' });
}

function applyAccountEffects(deps: ExecutionDeps, action: ActionRow, effects: readonly ErrorEffect[], now: number, actor: Actor): void {
  const accountId = action.provider_account_id;
  if (!accountId) return;
  if (effects.includes('account_unhealthy') || effects.includes('account_reauth')) {
    const health = effects.includes('account_unhealthy') ? 'unhealthy' : 'reauth_required';
    deps.db
      .prepare('UPDATE provider_accounts SET health = ?, health_detail = ?, health_checked_at = ? WHERE id = ?')
      .run(health, `set by action ${action.id}`, now, accountId);
  }
  if (effects.includes('engage_account_kill')) {
    setKillSwitch(
      deps.db,
      { workspaceId: action.workspace_id, scope: 'provider_account', targetId: accountId, engaged: true, reason: `provider:${action.last_error_class ?? 'error'}` },
      actor,
      now,
    );
  }
}

function applyRejection(
  deps: ExecutionDeps,
  action: ActionRow,
  attempt: AttemptRow,
  result: Extract<SendResult, { kind: 'rejected' }>,
  now: number,
  actor: Actor,
): void {
  const errorClass: ErrorClass = result.errorClass;
  const disposition = ERROR_DISPOSITIONS[errorClass];
  const retryable = disposition.retry !== 'never';
  finishAttempt(deps.db, attempt.id, retryable ? 'rejected_retryable' : 'rejected_permanent', now, {
    errorClass,
    detail: result.detail,
  });
  const tagged = { ...action, last_error_class: errorClass };
  applyAccountEffects(deps, tagged, disposition.effects, now, actor);
  if (disposition.effects.length) deps.effects?.onErrorEffects?.(deps.db, tagged, disposition.effects, now);
  const patch = { ...CLEAR_LEASE, last_error_class: errorClass };

  if (retryable) {
    releaseBudget(deps.db, action.workspace_id, JSON.parse(attempt.reservations) as Reservation[]);
    if (action.attempt_count >= action.max_attempts) {
      const failed = transitionAction(deps.db, action, 'failed', now, actor, { ...patch, state_reason: 'max_attempts' });
      deps.effects?.onFailed?.(deps.db, failed, errorClass, now);
      return;
    }
    const delay =
      disposition.retry === 'after_reauth'
        ? resolveConfig(deps).unhealthyAccountDeferMs
        : backoffMs(deps, action.attempt_count, result.retryAfterMs);
    const retrying = transitionAction(deps.db, action, 'retryable', now, actor, { ...patch, state_reason: errorClass });
    transitionAction(deps.db, retrying, 'scheduled', now, actor, { due_at: now + delay });
    return;
  }
  const terminal = disposition.terminal ?? 'failed';
  const finished = transitionAction(deps.db, action, terminal, now, actor, { ...patch, state_reason: errorClass });
  if (terminal === 'failed') deps.effects?.onFailed?.(deps.db, finished, errorClass, now);
}

function loadAttempt(db: SqlDatabase, attemptId: string): AttemptRow | undefined {
  return db.prepare('SELECT id, outcome, reservations FROM action_attempts WHERE id = ?').get<AttemptRow>(attemptId);
}

/** Records a provider result. Runs in its own transaction after the call returned. */
export function recordResult(deps: ExecutionDeps, actionId: string, attemptId: string, result: SendResult, actor: Actor): void {
  const config = resolveConfig(deps);
  deps.db.transaction(() => {
    const now = deps.now();
    const action = loadAction(deps.db, actionId);
    const attempt = loadAttempt(deps.db, attemptId);
    if (!action || !attempt) return;

    if (action.state === 'executing' && attempt.outcome === 'pending') {
      if (result.kind === 'accepted') return completeSuccess(deps, action, attempt.id, result.receipt, now, actor);
      if (result.kind === 'rejected') return applyRejection(deps, action, attempt, result, now, actor);
      finishAttempt(deps.db, attempt.id, 'uncertain', now, { detail: result.detail });
      if (action.kind === 'notify.publish') {
        // Notifications cannot be reconciled; per ADR 0002 they are never retried either.
        const failed = transitionAction(deps.db, action, 'failed', now, actor, { ...CLEAR_LEASE, state_reason: 'uncertain_not_reconcilable' });
        deps.effects?.onFailed?.(deps.db, failed, null, now);
        return;
      }
      transitionAction(deps.db, action, 'uncertain', now, actor, {
        ...CLEAR_LEASE,
        due_at: now + config.reconcileDelayMs,
        state_reason: 'provider_outcome_unknown',
      });
      return;
    }

    // The lease expired mid-call and the sweeper parked the action as uncertain. A definitive
    // answer from this very attempt resolves it exactly like reconciliation would.
    if (action.state === 'uncertain' && attempt.outcome === 'uncertain' && result.kind !== 'unknown') {
      const reconciling = transitionAction(deps.db, action, 'reconciling', now, actor, { state_reason: 'late_result' });
      if (result.kind === 'accepted') return completeSuccess(deps, reconciling, attempt.id, result.receipt, now, actor);
      return confirmAbsent(deps, reconciling, attempt, now, actor);
    }
  });
}
