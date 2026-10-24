import { ulid, type SqlDatabase } from '@splitin/outreach-contracts';
import { loadAccount, transitionAction, type Actor } from './actions-repo';
import { providerContext } from './invoke';
import { completeSuccess, confirmAbsent } from './results';
import { resolveConfig, type ActionRow, type ExecutionDeps } from './types';

interface AttemptRow {
  id: string;
  outcome: string;
  reservations: string;
  started_at: number;
}

function latestAttempt(db: SqlDatabase, actionId: string): AttemptRow | undefined {
  return db
    .prepare('SELECT id, outcome, reservations, started_at FROM action_attempts WHERE action_id = ? ORDER BY attempt_no DESC LIMIT 1')
    .get<AttemptRow>(actionId);
}

export interface SweepReport {
  readonly released: number;
  readonly madeUncertain: number;
}

/**
 * Recovers from dead workers. A `claimed` action with an expired lease never started an attempt, so it is
 * safe to schedule again. An `executing` or `reconciling` one may have reached the provider: it becomes
 * `uncertain` and is never retried without reconciliation.
 */
export function sweepExpiredLeases(deps: ExecutionDeps, actor: Actor): SweepReport {
  const config = resolveConfig(deps);
  return deps.db.transaction(() => {
    const now = deps.now();
    const expired = deps.db
      .prepare(
        `SELECT * FROM scheduled_actions WHERE state IN ('claimed','executing','reconciling')
         AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .all<ActionRow>(now);
    let released = 0;
    let madeUncertain = 0;
    for (const action of expired) {
      const patch = { lease_owner: null, lease_expires_at: null };
      if (action.state === 'claimed') {
        transitionAction(deps.db, action, 'scheduled', now, actor, { ...patch, state_reason: 'lease_expired' });
        released += 1;
        continue;
      }
      if (action.state === 'executing') {
        const attempt = latestAttempt(deps.db, action.id);
        if (attempt?.outcome === 'pending') {
          deps.db.prepare(`UPDATE action_attempts SET outcome = 'uncertain', finished_at = ?, error_detail = ? WHERE id = ?`)
            .run(now, 'worker lease expired during execution', attempt.id);
        }
      }
      transitionAction(deps.db, action, 'uncertain', now, actor, {
        ...patch,
        due_at: now + config.reconcileDelayMs,
        state_reason: 'lease_expired_during_execution',
      });
      madeUncertain += 1;
    }
    return { released, madeUncertain };
  });
}

export interface ReconcileReport {
  readonly found: number;
  readonly absent: number;
  readonly stillUnknown: number;
  readonly toReview: number;
}

/** Resolves `uncertain` actions by asking the provider. Only an affirmed `absent` allows another attempt. */
export async function reconcileUncertain(deps: ExecutionDeps, actor: Actor, limit = 25): Promise<ReconcileReport> {
  const config = resolveConfig(deps);
  const report = { found: 0, absent: 0, stillUnknown: 0, toReview: 0 };
  const claimed = deps.db.transaction(() => {
    const now = deps.now();
    const due = deps.db
      .prepare(`SELECT * FROM scheduled_actions WHERE state = 'uncertain' AND due_at <= ? ORDER BY due_at LIMIT ?`)
      .all<ActionRow>(now, limit);
    return due.map((action) =>
      transitionAction(deps.db, action, 'reconciling', now, actor, {
        lease_owner: deps.workerId,
        lease_expires_at: now + config.executeLeaseMs,
      }),
    );
  });

  for (const action of claimed) {
    const account = loadAccount(deps.db, action.provider_account_id);
    const adapter = account ? deps.adapters.get(account.provider) : undefined;
    const attempt = latestAttempt(deps.db, action.id);
    let result: Awaited<ReturnType<NonNullable<NonNullable<typeof adapter>['email']>['reconcile']>> = {
      kind: 'still_unknown',
      detail: 'no reconciler for this action',
    };
    if (account && adapter?.email && attempt && (action.kind === 'email.send' || action.kind === 'email.reply')) {
      try {
        const signal = AbortSignal.timeout(config.providerTimeoutMs);
        result = await adapter.email.reconcile(providerContext(deps, account, ulid(), signal), {
          actionId: action.id,
          idempotencyKey: action.idempotency_key,
          rfcMessageId: action.rfc_message_id ?? '',
          to: action.recipient_norm ? [action.recipient_norm] : [],
          attemptedAt: attempt.started_at,
        });
      } catch (error) {
        result = { kind: 'still_unknown', detail: `reconcile threw: ${(error as Error).message}` };
      }
    }

    deps.db.transaction(() => {
      const now = deps.now();
      const current = deps.db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get<ActionRow>(action.id);
      if (!current || current.state !== 'reconciling' || current.lease_owner !== deps.workerId || !attempt) return;
      if (result.kind === 'found') {
        report.found += 1;
        return completeSuccess(deps, current, attempt.id, result.receipt, now, actor);
      }
      if (result.kind === 'absent') {
        report.absent += 1;
        return confirmAbsent(deps, current, attempt, now, actor);
      }
      const count = current.reconcile_count + 1;
      const patch = { lease_owner: null, lease_expires_at: null, reconcile_count: count, state_reason: result.detail.slice(0, 200) };
      if (count >= config.maxReconcileAttempts) {
        report.toReview += 1;
        transitionAction(deps.db, current, 'review', now, actor, patch);
        return;
      }
      report.stillUnknown += 1;
      transitionAction(deps.db, current, 'uncertain', now, actor, { ...patch, due_at: now + config.reconcileDelayMs * 2 ** count });
    });
  }
  return report;
}
