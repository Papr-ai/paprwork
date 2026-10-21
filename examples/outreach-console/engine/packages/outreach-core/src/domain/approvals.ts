import { digestCanonical, ulid, type SqlDatabase } from '@splitin/outreach-contracts';
import { transitionAction } from '../execution/actions-repo';
import type { ActionRow, PreflightVerdict } from '../execution/types';
import { ConflictError, ForbiddenError, NotFoundError, actorOf, audit, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import { stopEnrollment } from './suppressions';

export type ApprovalScope = 'action' | 'batch' | 'campaign_version';
export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired';

export interface ApprovalRow {
  id: string;
  workspace_id: string;
  scope: ApprovalScope;
  subject_id: string;
  operation_hash: string;
  preview: string;
  requested_by: string;
  decided_by: string | null;
  decision: ApprovalDecision;
  reason: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  consumed_count: number;
}

export const APPROVAL_TTL_MS = 72 * 3_600_000;

export interface BatchPreviewItem {
  readonly id: string;
  readonly contentHash: string;
  readonly recipient: string | null;
}

export function batchHash(items: readonly BatchPreviewItem[]): string {
  return digestCanonical([...items].map((item) => `${item.id}:${item.contentHash}`).sort());
}

export function createApproval(
  db: SqlDatabase,
  input: { workspaceId: string; scope: ApprovalScope; subjectId: string; operationHash: string; preview: unknown; requestedBy: string },
  now: number,
): string {
  const id = ulid(now);
  db.prepare(
    `INSERT INTO approvals (id, workspace_id, scope, subject_id, operation_hash, preview, requested_by, decision, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,'pending',?,?)`,
  ).run(id, input.workspaceId, input.scope, input.subjectId, input.operationHash, JSON.stringify(input.preview), input.requestedBy, now, now + APPROVAL_TTL_MS);
  return id;
}

export function loadApproval(db: SqlDatabase, workspaceId: string, id: string): ApprovalRow | undefined {
  return db.prepare('SELECT * FROM approvals WHERE workspace_id = ? AND id = ?').get<ApprovalRow>(workspaceId, id);
}

/** Preflight view of an action's approval: only an unexpired approval of this exact content passes. */
export function approvalVerdict(db: SqlDatabase, action: ActionRow, now: number): PreflightVerdict {
  if (!action.approval_id) return { kind: 'pass' };
  const approval = loadApproval(db, action.workspace_id, action.approval_id);
  if (!approval) return { kind: 'await_approval', reason: 'approval_missing' };
  if (approval.decision === 'rejected') return { kind: 'cancel', reason: 'approval_rejected' };
  if (approval.decision !== 'approved') return { kind: 'await_approval', reason: `approval_${approval.decision}` };
  if (approval.scope === 'campaign_version') {
    const version = db.prepare('SELECT version_hash FROM campaign_versions WHERE id = ?').get<{ version_hash: string | null }>(approval.subject_id);
    return version?.version_hash === approval.operation_hash ? { kind: 'pass' } : { kind: 'await_approval', reason: 'approval_hash_mismatch' };
  }
  if (now > approval.expires_at) return { kind: 'await_approval', reason: 'approval_expired' };
  if (approval.scope === 'action') {
    return approval.operation_hash === action.content_hash ? { kind: 'pass' } : { kind: 'await_approval', reason: 'approval_hash_mismatch' };
  }
  const items = (JSON.parse(approval.preview) as { actions: BatchPreviewItem[] }).actions;
  return items.some((item) => item.id === action.id && item.contentHash === action.content_hash)
    ? { kind: 'pass' }
    : { kind: 'await_approval', reason: 'approval_hash_mismatch' };
}

function workspaceSettings(db: SqlDatabase, workspaceId: string): { separationOfDuties?: boolean } {
  const row = db.prepare('SELECT settings FROM workspaces WHERE id = ?').get<{ settings: string }>(workspaceId);
  return row ? (JSON.parse(row.settings) as { separationOfDuties?: boolean }) : {};
}

export interface DecisionInput {
  readonly approvalId: string;
  readonly decision: 'approved' | 'rejected';
  /** The hash the approver was shown; must still match (BUILD_PLAN.md §9.3). */
  readonly operationHash: string;
  readonly reason?: string;
}

export function decideApproval(env: DomainEnv, ctx: AuthContext, input: DecisionInput): ApprovalRow {
  requireRole(ctx, 'approver');
  const { db } = env;
  return db.transaction(() => {
    const now = env.now();
    const approval = loadApproval(db, ctx.workspaceId, input.approvalId);
    if (!approval) throw new NotFoundError(`approval ${input.approvalId}`);
    if (approval.decision !== 'pending') throw new ConflictError(`approval is ${approval.decision}`);
    if (now > approval.expires_at) {
      db.prepare(`UPDATE approvals SET decision = 'expired', decided_at = ? WHERE id = ?`).run(now, approval.id);
      throw new ConflictError('approval expired; request a new one');
    }
    if (approval.operation_hash !== input.operationHash) throw new ConflictError('operation hash does not match what is pending');
    if (workspaceSettings(db, ctx.workspaceId).separationOfDuties && approval.requested_by === ctx.principalId) {
      throw new ForbiddenError('separation of duties: the requester cannot approve');
    }
    db.prepare('UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ?')
      .run(input.decision, ctx.principalId, now, input.reason ?? null, approval.id);
    const actor = actorOf(ctx);
    const waiting = db
      .prepare(`SELECT * FROM scheduled_actions WHERE approval_id = ? AND state = 'awaiting_approval'`)
      .all<ActionRow>(approval.id);
    for (const action of waiting) {
      if (input.decision === 'approved') {
        transitionAction(db, action, 'scheduled', now, actor, { state_reason: null });
      } else {
        transitionAction(db, action, 'cancelled', now, actor, { state_reason: 'approval_rejected' });
        if (action.enrollment_id) stopEnrollment(db, action.enrollment_id, 'stopped', 'approval_rejected', actor, now);
      }
    }
    audit(db, ctx, now, 'approval', approval.id, input.decision, { scope: approval.scope, actions: waiting.length, reason: input.reason ?? null });
    return { ...approval, decision: input.decision, decided_by: ctx.principalId, decided_at: now };
  });
}

export function revokeApproval(env: DomainEnv, ctx: AuthContext, approvalId: string, reason: string): void {
  requireRole(ctx, 'approver');
  env.db.transaction(() => {
    const now = env.now();
    const approval = loadApproval(env.db, ctx.workspaceId, approvalId);
    if (!approval) throw new NotFoundError(`approval ${approvalId}`);
    if (approval.decision !== 'approved' && approval.decision !== 'pending') throw new ConflictError(`approval is ${approval.decision}`);
    env.db.prepare(`UPDATE approvals SET decision = 'revoked', reason = ?, decided_at = ? WHERE id = ?`).run(reason, now, approvalId);
    audit(env.db, ctx, now, 'approval', approvalId, 'revoked', { reason });
  });
}

/** Gathers a campaign's actions that wait without a live approval into one new batch approval. */
export function requestBatchApproval(env: DomainEnv, ctx: AuthContext, campaignId: string): { approvalId: string; operationHash: string; count: number } | null {
  requireRole(ctx, 'operator');
  return env.db.transaction(() => {
    const now = env.now();
    const actions = env.db
      .prepare(
        `SELECT a.* FROM scheduled_actions a LEFT JOIN approvals p ON p.id = a.approval_id
         WHERE a.workspace_id = ? AND a.campaign_id = ? AND a.state = 'awaiting_approval'
           AND (p.id IS NULL OR p.decision <> 'pending' OR p.expires_at < ?)
         ORDER BY a.due_at LIMIT 500`,
      )
      .all<ActionRow>(ctx.workspaceId, campaignId, now);
    if (!actions.length) return null;
    const approvalId = createBatchApproval(env.db, ctx.workspaceId, campaignId, actions, ctx.principalId, now);
    audit(env.db, ctx, now, 'approval', approvalId, 'requested', { scope: 'batch', count: actions.length });
    const row = loadApproval(env.db, ctx.workspaceId, approvalId);
    return { approvalId, operationHash: row?.operation_hash ?? '', count: actions.length };
  });
}

export function createBatchApproval(
  db: SqlDatabase,
  workspaceId: string,
  campaignId: string,
  actions: readonly Pick<ActionRow, 'id' | 'content_hash' | 'recipient_norm' | 'payload'>[],
  requestedBy: string,
  now: number,
): string {
  const items: (BatchPreviewItem & { subject?: string })[] = actions.map((action) => ({
    id: action.id,
    contentHash: action.content_hash,
    recipient: action.recipient_norm,
    subject: (JSON.parse(action.payload) as { subject?: string }).subject,
  }));
  const approvalId = createApproval(
    db,
    { workspaceId, scope: 'batch', subjectId: campaignId, operationHash: batchHash(items), preview: { actions: items }, requestedBy },
    now,
  );
  const update = db.prepare('UPDATE scheduled_actions SET approval_id = ? WHERE id = ?');
  for (const item of items) update.run(approvalId, item.id);
  return approvalId;
}

export function listApprovals(db: SqlDatabase, ctx: AuthContext, decision: ApprovalDecision = 'pending'): ApprovalRow[] {
  requireRole(ctx, 'viewer');
  return db
    .prepare('SELECT * FROM approvals WHERE workspace_id = ? AND decision = ? ORDER BY created_at')
    .all<ApprovalRow>(ctx.workspaceId, decision);
}
