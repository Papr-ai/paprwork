import { appendAudit, ulid, type AccountHealth, type SqlDatabase } from '@splitin/outreach-contracts';
import { loadAccount } from '../execution/actions-repo';
import { enqueueAction } from '../execution/enqueue';
import { providerContext } from '../execution/invoke';
import type { AccountRow } from '../execution/types';
import { NotFoundError } from './auth';
import type { DomainEnv } from './env';

const CHECK_TIMEOUT_MS = 30_000;
const BAD: ReadonlySet<AccountHealth> = new Set(['unhealthy', 'reauth_required']);

export interface HealthObservation {
  readonly status: AccountHealth;
  readonly detail?: string;
  /** False when the check could not reach a verdict (it threw or timed out). */
  readonly affirmative: boolean;
}

export interface HealthResult {
  readonly accountId: string;
  readonly status: AccountHealth;
  readonly detail: string | null;
  readonly changed: boolean;
}

/**
 * Which state to store. An account marked unhealthy or reauth_required (by a check or by a failed send)
 * recovers only on an affirmative `ok`: a timeout or a `degraded` answer must not re-enable sending on a
 * revoked account.
 */
export function nextHealth(current: AccountHealth, observed: HealthObservation): AccountHealth {
  if (!BAD.has(current)) return observed.affirmative ? observed.status : 'degraded';
  if (!observed.affirmative) return current;
  return observed.status === 'ok' || BAD.has(observed.status) ? observed.status : current;
}

function notifyChange(db: SqlDatabase, account: AccountRow, from: AccountHealth, to: AccountHealth, detail: string | null, now: number): void {
  const settings = JSON.parse(db.prepare('SELECT settings FROM workspaces WHERE id = ?').get<{ settings: string }>(account.workspace_id)?.settings ?? '{}') as { notifyAccountId?: string };
  // Never route a notice about an account through that same account.
  if (!settings.notifyAccountId || settings.notifyAccountId === account.id) return;
  const recovered = to === 'ok' && BAD.has(from);
  if (!BAD.has(to) && !recovered) return;
  const sender = (JSON.parse(account.sender_identity) as { address?: string }).address ?? account.external_account_id;
  enqueueAction(db, {
    workspaceId: account.workspace_id,
    kind: 'notify.publish',
    providerAccountId: settings.notifyAccountId,
    idempotencyKey: `health:${account.id}:${to}:${now}`,
    dueAt: now,
    payload: {
      title: recovered ? `Sending account ${sender} is healthy again` : to === 'reauth_required' ? `Reconnect sending account ${sender}` : `Sending account ${sender} is unhealthy`,
      lines: [`Provider: ${account.provider}`, `Status: ${from} -> ${to}`, ...(detail ? [`Detail: ${detail.slice(0, 200)}`] : [])],
      severity: recovered ? 'info' : 'error',
    },
  }, { kind: 'system', id: 'health-checker', source: 'worker', traceId: ulid(now) }, now);
}

/** Stores an observation in one transaction; audits and notifies only when the stored state changes. */
export function recordAccountHealth(db: SqlDatabase, accountId: string, observed: HealthObservation, now: number): HealthResult {
  return db.transaction(() => {
    const account = loadAccount(db, accountId);
    if (!account) throw new NotFoundError(`provider account ${accountId}`);
    const status = nextHealth(account.health, observed);
    const detail = observed.detail?.slice(0, 500) ?? null;
    db.prepare('UPDATE provider_accounts SET health = ?, health_detail = ?, health_checked_at = ? WHERE id = ?').run(status, detail, now, accountId);
    const changed = status !== account.health;
    if (changed) {
      appendAudit(db, {
        workspaceId: account.workspace_id,
        at: now,
        actorKind: 'system',
        actorId: 'health-checker',
        source: 'worker',
        traceId: ulid(now),
        resourceKind: 'provider_account',
        resourceId: accountId,
        action: 'health_changed',
        detail: { from: account.health, to: status, detail },
      });
      notifyChange(db, account, account.health, status, detail, now);
    }
    return { accountId, status, detail, changed };
  });
}

/** Asks the adapter for the account's health (BUILD_PLAN.md §6.5) and records the answer. */
export async function checkAccountHealth(env: DomainEnv, accountId: string): Promise<HealthResult> {
  const account = loadAccount(env.db, accountId);
  if (!account) throw new NotFoundError(`provider account ${accountId}`);
  const adapter = env.adapters.get(account.provider);
  if (!adapter) throw new NotFoundError(`adapter ${account.provider} (not registered in this process)`);
  let observed: HealthObservation;
  try {
    const answer = await adapter.account.health(providerContext(env.exec, account, ulid(), AbortSignal.timeout(CHECK_TIMEOUT_MS)));
    observed = { status: answer.status, affirmative: true, ...(answer.detail ? { detail: answer.detail } : {}) };
  } catch (error) {
    observed = { status: 'degraded', affirmative: false, detail: `health check failed: ${(error as Error).message}` };
  }
  return recordAccountHealth(env.db, accountId, observed, env.now());
}

/**
 * Checks every account last checked more than `intervalMs` ago whose adapter this process has. Accounts
 * whose adapter is missing are left alone: preflight already holds their sends for review.
 */
export async function checkDueAccountHealth(env: DomainEnv, intervalMs: number): Promise<{ checked: number; changed: number }> {
  const due = env.db
    .prepare('SELECT id, provider FROM provider_accounts WHERE health_checked_at IS NULL OR health_checked_at <= ? ORDER BY health_checked_at')
    .all<{ id: string; provider: string }>(env.now() - intervalMs);
  let checked = 0;
  let changed = 0;
  for (const account of due) {
    if (!env.adapters.has(account.provider)) continue;
    const result = await checkAccountHealth(env, account.id);
    checked += 1;
    if (result.changed) changed += 1;
  }
  return { checked, changed };
}
