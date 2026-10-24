import { appendAudit, digestCanonical, ulid, type ActionKind, type SqlDatabase } from '@splitin/outreach-contracts';
import type { Actor } from './actions-repo';
import type { ActionRow } from './types';

export interface EnqueueInput {
  readonly workspaceId: string;
  readonly kind: ActionKind;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly dueAt: number;
  readonly providerAccountId?: string | null;
  readonly purpose?: string | null;
  readonly recipient?: string | null;
  readonly enrollmentId?: string | null;
  readonly campaignId?: string | null;
  readonly stepId?: string | null;
  readonly contactPointId?: string | null;
  readonly notAfter?: number | null;
  readonly maxAttempts?: number;
  /** Email kinds: the Message-ID we will set; generated if absent. */
  readonly rfcMessageId?: string | null;
  readonly senderDomain?: string;
  readonly awaitingApproval?: boolean;
  readonly approvalId?: string | null;
}

export type EnqueueResult = { created: true; action: ActionRow } | { created: false; action: ActionRow };

/**
 * Creates a durable action. Every external effect starts here. Idempotent on (workspace, idempotency key):
 * enqueueing the same logical action twice returns the existing row. Must run inside a transaction.
 */
export function enqueueAction(db: SqlDatabase, input: EnqueueInput, actor: Actor, now: number): EnqueueResult {
  const existing = db
    .prepare('SELECT * FROM scheduled_actions WHERE workspace_id = ? AND idempotency_key = ?')
    .get<ActionRow>(input.workspaceId, input.idempotencyKey);
  if (existing) return { created: false, action: existing };

  const id = ulid(now);
  const isEmail = input.kind === 'email.send' || input.kind === 'email.reply';
  const rfcMessageId = isEmail ? (input.rfcMessageId ?? `<${id.toLowerCase()}@${input.senderDomain ?? 'outreach.invalid'}>`) : null;
  const payload = JSON.stringify(input.payload);
  const state = input.awaitingApproval ? 'awaiting_approval' : 'scheduled';
  db.prepare(
    `INSERT INTO scheduled_actions (id, workspace_id, enrollment_id, campaign_id, step_id, contact_point_id, kind,
       purpose, provider_account_id, recipient_norm, state, due_at, not_after, payload, content_hash, idempotency_key,
       rfc_message_id, approval_id, max_attempts, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.workspaceId,
    input.enrollmentId ?? null,
    input.campaignId ?? null,
    input.stepId ?? null,
    input.contactPointId ?? null,
    input.kind,
    input.purpose ?? null,
    input.providerAccountId ?? null,
    input.recipient?.toLowerCase() ?? null,
    state,
    input.dueAt,
    input.notAfter ?? null,
    payload,
    digestCanonical(input.payload),
    input.idempotencyKey,
    rfcMessageId,
    input.approvalId ?? null,
    input.maxAttempts ?? 5,
    now,
    now,
  );
  appendAudit(db, {
    workspaceId: input.workspaceId,
    at: now,
    actorKind: actor.kind,
    actorId: actor.id,
    source: actor.source,
    traceId: actor.traceId,
    resourceKind: 'action',
    resourceId: id,
    action: `created:${state}`,
    detail: { kind: input.kind, dueAt: input.dueAt, enrollmentId: input.enrollmentId ?? null },
  });
  const action = db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get<ActionRow>(id);
  if (!action) throw new Error(`Action ${id} vanished after insert`);
  return { created: true, action };
}
