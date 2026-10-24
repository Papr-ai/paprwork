import {
  appendAudit,
  assertTransition,
  type ActionState,
  type AuditActorKind,
  type SqlDatabase,
  type SqlValue,
} from '@splitin/outreach-contracts';
import type { AccountRow, ActionRow } from './types';

export interface Actor {
  readonly kind: AuditActorKind;
  readonly id: string;
  readonly source: string;
  readonly traceId: string;
}

export function loadAction(db: SqlDatabase, id: string): ActionRow | undefined {
  return db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get<ActionRow>(id);
}

export function loadAccount(db: SqlDatabase, id: string | null): AccountRow | null {
  if (!id) return null;
  return db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get<AccountRow>(id) ?? null;
}

export class StaleActionError extends Error {
  constructor(id: string, expected: ActionState) {
    super(`Action ${id} is no longer in state ${expected}`);
    this.name = 'StaleActionError';
  }
}

type ActionPatch = Partial<
  Pick<
    ActionRow,
    | 'due_at'
    | 'lease_owner'
    | 'lease_expires_at'
    | 'attempt_count'
    | 'reconcile_count'
    | 'last_error_class'
    | 'state_reason'
    | 'approval_id'
  >
>;

/**
 * The only way an action changes state. Enforces the transition table, compares-and-sets on the
 * expected state (so a concurrent change is detected, never overwritten), and appends an audit row.
 * Must run inside a transaction.
 */
export function transitionAction(
  db: SqlDatabase,
  action: ActionRow,
  to: ActionState,
  now: number,
  actor: Actor,
  patch: ActionPatch = {},
  detail: Record<string, unknown> = {},
): ActionRow {
  assertTransition(action.state, to);
  const columns = Object.keys(patch) as (keyof ActionPatch)[];
  const sets = ['state = ?', 'updated_at = ?', ...columns.map((column) => `${column} = ?`)];
  const values: SqlValue[] = [to, now, ...columns.map((column) => (patch[column] ?? null) as SqlValue)];
  const result = db
    .prepare(`UPDATE scheduled_actions SET ${sets.join(', ')} WHERE id = ? AND state = ?`)
    .run(...values, action.id, action.state);
  if (result.changes !== 1) throw new StaleActionError(action.id, action.state);
  appendAudit(db, {
    workspaceId: action.workspace_id,
    at: now,
    actorKind: actor.kind,
    actorId: actor.id,
    source: actor.source,
    traceId: actor.traceId,
    resourceKind: 'action',
    resourceId: action.id,
    action: `${action.state}->${to}`,
    detail: { ...detail, ...(patch.state_reason ? { reason: patch.state_reason } : {}) },
  });
  return { ...action, ...patch, state: to, updated_at: now };
}

export function workerActor(workerId: string, traceId: string): Actor {
  return { kind: 'worker', id: workerId, source: 'worker', traceId };
}
