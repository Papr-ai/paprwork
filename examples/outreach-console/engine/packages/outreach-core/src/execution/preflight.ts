import { purposePermitted, ulid, type ProviderPurpose, type SqlDatabase } from '@splitin/outreach-contracts';
import { loadAccount, loadAction, transitionAction, type Actor } from './actions-repo';
import { engagedKillSwitch } from './kill-switches';
import { reserveBudget } from './rate';
import {
  resolveConfig,
  type ActionRow,
  type ExecutionDeps,
  type PreflightCheck,
  type PreflightInput,
  type PreflightVerdict,
  type Reservation,
  type SendGate,
} from './types';

export type PreflightOutcome =
  | { kind: 'go'; action: ActionRow; attemptId: string; attemptNo: number; reservations: Reservation[] }
  | { kind: 'stopped'; verdict: PreflightVerdict['kind'] }
  /** The lease was lost or the action changed underneath us; another path owns it now. */
  | { kind: 'lost' };

/** Atomically claims up to `limit` due actions for this worker. */
export function claimActions(deps: ExecutionDeps, actor: Actor, limit: number): string[] {
  const config = resolveConfig(deps);
  const now = deps.now();
  return deps.db.transaction(() => {
    const due = deps.db
      .prepare(`SELECT * FROM scheduled_actions WHERE state = 'scheduled' AND due_at <= ? ORDER BY due_at, id LIMIT ?`)
      .all<ActionRow>(now, limit);
    return due.map(
      (action) =>
        transitionAction(deps.db, action, 'claimed', now, actor, {
          lease_owner: deps.workerId,
          lease_expires_at: now + config.claimLeaseMs,
        }).id,
    );
  });
}

function isEmail(action: ActionRow): boolean {
  return action.kind === 'email.send' || action.kind === 'email.reply';
}

export function recipientAllowed(gate: SendGate, recipient: string | null): boolean {
  if (gate.mode === 'open') return true;
  if (!recipient) return false;
  const domain = recipient.split('@')[1] ?? '';
  return gate.allow.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (rule.includes('@') && !rule.startsWith('@')) return rule === recipient;
    return rule.replace(/^@/, '') === domain;
  });
}

function builtInChecks(deps: ExecutionDeps): { before: PreflightCheck[]; after: PreflightCheck[] } {
  const config = resolveConfig(deps);
  const killSwitch: PreflightCheck = ({ db, action, now }) => {
    const scope = engagedKillSwitch(db, action.workspace_id, action.provider_account_id, action.campaign_id);
    return scope ? { kind: 'defer', until: now + config.killSwitchDeferMs, reason: `kill_switch:${scope}` } : { kind: 'pass' };
  };
  const expiry: PreflightCheck = ({ action, now }) =>
    action.not_after !== null && now > action.not_after ? { kind: 'cancel', reason: 'expired' } : { kind: 'pass' };
  const account: PreflightCheck = ({ action, account: acct, adapter, now }) => {
    if (action.kind === 'manual.task') return { kind: 'pass' };
    if (!acct) return { kind: 'review', reason: 'provider_account_missing' };
    if (!adapter) return { kind: 'review', reason: `adapter_not_registered:${acct.provider}` };
    if (acct.health !== 'ok' && acct.health !== 'degraded') {
      return { kind: 'defer', until: now + config.unhealthyAccountDeferMs, reason: `account_${acct.health}` };
    }
    if (isEmail(action)) {
      if (!adapter.email) return { kind: 'review', reason: 'unsupported:email' };
      const purpose = (action.purpose ?? 'automated_outreach') as ProviderPurpose;
      const accountPurposes = JSON.parse(acct.purposes) as ProviderPurpose[];
      if (!purposePermitted(purpose, adapter.purposes, accountPurposes)) {
        return { kind: 'review', reason: `purpose_not_permitted:${purpose}` };
      }
    }
    if (action.kind === 'notify.publish' && !adapter.notify) return { kind: 'review', reason: 'unsupported:notify' };
    return { kind: 'pass' };
  };
  const gate: PreflightCheck = ({ action }) =>
    isEmail(action) && !recipientAllowed(typeof deps.sendGate === 'function' ? deps.sendGate(deps.db, action.workspace_id) : deps.sendGate, action.recipient_norm)
      ? { kind: 'review', reason: 'not_in_live_allowlist' }
      : { kind: 'pass' };
  return { before: [killSwitch, expiry], after: [account, gate] };
}

function applyVerdict(deps: ExecutionDeps, input: PreflightInput, verdict: PreflightVerdict, actor: Actor): void {
  const { db, action, now } = input;
  const release = { lease_owner: null, lease_expires_at: null, state_reason: 'reason' in verdict ? verdict.reason : null };
  switch (verdict.kind) {
    case 'pass':
      return;
    case 'defer':
      transitionAction(db, action, 'scheduled', now, actor, { ...release, due_at: verdict.until });
      return;
    case 'cancel': {
      const cancelled = transitionAction(db, action, 'cancelled', now, actor, release);
      deps.effects?.onCancelled?.(db, cancelled, verdict.reason, now);
      return;
    }
    case 'await_approval':
      transitionAction(db, action, 'awaiting_approval', now, actor, release);
      return;
    case 'review':
      transitionAction(db, action, 'review', now, actor, release);
      return;
  }
}

/**
 * The last gate before an external effect. In one transaction: re-validate the lease, run every check,
 * reserve rate budget, then commit `executing` plus a pending attempt BEFORE the provider is called.
 */
export function preflight(deps: ExecutionDeps, actionId: string, actor: Actor): PreflightOutcome {
  const config = resolveConfig(deps);
  const db: SqlDatabase = deps.db;
  return db.transaction((): PreflightOutcome => {
    const now = deps.now();
    const action = loadAction(db, actionId);
    if (!action || action.state !== 'claimed' || action.lease_owner !== deps.workerId) return { kind: 'lost' };
    if ((action.lease_expires_at ?? 0) < now) return { kind: 'lost' };

    const account = loadAccount(db, action.provider_account_id);
    const adapter = account ? (deps.adapters.get(account.provider) ?? null) : null;
    const input: PreflightInput = { db, action, account, adapter, now };
    const { before, after } = builtInChecks(deps);
    for (const check of [...before, ...(deps.checks ?? []), ...after]) {
      const verdict = check(input);
      if (verdict.kind !== 'pass') {
        applyVerdict(deps, input, verdict, actor);
        return { kind: 'stopped', verdict: verdict.kind };
      }
    }

    let reservations: Reservation[] = [];
    if (action.kind !== 'manual.task' && deps.ratePolicy) {
      const budget = reserveBudget(db, action.workspace_id, action.recipient_norm, deps.ratePolicy(db, action), now);
      if (!budget.ok) {
        applyVerdict(deps, input, { kind: 'defer', until: budget.retryAt, reason: budget.reason }, actor);
        return { kind: 'stopped', verdict: 'defer' };
      }
      reservations = budget.reservations;
    }

    const attemptNo = action.attempt_count + 1;
    const attemptId = ulid(now);
    db.prepare(
      `INSERT INTO action_attempts (id, action_id, attempt_no, outcome, reservations, started_at)
       VALUES (?,?,?,'pending',?,?)`,
    ).run(attemptId, action.id, attemptNo, JSON.stringify(reservations), now);
    const executing = transitionAction(db, action, 'executing', now, actor, {
      attempt_count: attemptNo,
      lease_expires_at: now + config.executeLeaseMs,
      state_reason: null,
    });
    return { kind: 'go', action: executing, attemptId, attemptNo, reservations };
  });
}
