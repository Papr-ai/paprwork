import { appendAudit, ulid, type InboundMailEvent, type SqlDatabase } from '@splitin/outreach-contracts';
import type { Actor } from '../execution/actions-repo';
import { enqueueAction } from '../execution/enqueue';
import { setKillSwitch } from '../execution/kill-switches';
import type { DomainEnv } from '../domain/env';
import { addSuppression, liveEnrollmentsForContact, stopEnrollment } from '../domain/suppressions';
import { classifyInbound, type InboundClass } from './classify';
import { correlateInbound, type Correlation } from './correlate';

interface EventRow {
  id: string;
  workspace_id: string;
  provider_account_id: string;
  provider_event_id: string;
  payload: string;
}

export interface ProcessReport {
  readonly processed: number;
  readonly stopped: number;
  readonly toReview: number;
  readonly ignored: number;
}

const SOFT_BOUNCES_BEFORE_STOP = 3;

function inboundActor(eventId: string): Actor {
  return { kind: 'provider', id: 'inbound', source: 'inbound', traceId: eventId };
}

function enrollmentRecipient(db: SqlDatabase, enrollmentId: string): { contactId: string; email: string } | undefined {
  return db
    .prepare('SELECT e.contact_id AS contactId, cp.value_norm AS email FROM enrollments e JOIN contact_points cp ON cp.id = e.contact_point_id WHERE e.id = ?')
    .get<{ contactId: string; email: string }>(enrollmentId);
}

function recordInboundMessage(db: SqlDatabase, row: EventRow, event: InboundMailEvent, enrollmentId: string | null, now: number): void {
  if (event.kind !== 'message') return;
  db.prepare(
    `INSERT INTO messages (id, workspace_id, direction, provider_account_id, provider_message_id, provider_thread_id, rfc_message_id,
       in_reply_to, references_ids, from_addr, to_addrs, recipient_norm, subject, at, enrollment_id)
     VALUES (?,?,'inbound',?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (provider_account_id, provider_message_id) DO NOTHING`,
  ).run(ulid(now), row.workspace_id, row.provider_account_id, event.providerMessageId, event.providerThreadId ?? null, event.rfcMessageId ?? null,
    event.inReplyTo ?? null, JSON.stringify(event.references), event.from, JSON.stringify(event.to), event.from.toLowerCase(), event.subject ?? null, event.receivedAt, enrollmentId);
}

function notify(db: SqlDatabase, row: EventRow, cls: InboundClass, correlation: Correlation | null, event: InboundMailEvent, now: number): void {
  const settings = JSON.parse(db.prepare('SELECT settings FROM workspaces WHERE id = ?').get<{ settings: string }>(row.workspace_id)?.settings ?? '{}') as { notifyAccountId?: string };
  if (!settings.notifyAccountId || ['auto_reply', 'delivery', 'soft_bounce'].includes(cls)) return;
  const titles: Partial<Record<InboundClass, string>> = {
    human_reply: 'Reply received: sequence stopped',
    opt_out: 'Opt-out: contact suppressed',
    hard_bounce: 'Hard bounce: address suppressed',
    complaint: 'Complaint: sending account paused',
    unknown: 'Inbound message needs review',
  };
  const campaign = correlation
    ? db.prepare('SELECT c.name FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id WHERE e.id = ?').get<{ name: string }>(correlation.enrollmentId)?.name
    : undefined;
  enqueueAction(db, {
    workspaceId: row.workspace_id,
    kind: 'notify.publish',
    providerAccountId: settings.notifyAccountId,
    idempotencyKey: `inbound:${row.id}`,
    dueAt: now,
    payload: {
      title: titles[cls] ?? 'Inbound event needs review',
      // Identifiers and routing only: no message bodies in chat channels.
      lines: [`From: ${event.from}`, ...(campaign ? [`Campaign: ${campaign}`] : []), ...(correlation?.strength === 'weak' ? ['Matched by address only; please confirm.'] : [])],
      severity: cls === 'complaint' ? 'error' : cls === 'human_reply' ? 'info' : 'warning',
    },
  }, inboundActor(row.id), now);
}

/** Applies one classified event in the caller's transaction. Returns the resulting event status. */
function apply(db: SqlDatabase, row: EventRow, event: InboundMailEvent, cls: InboundClass, correlation: Correlation | null, now: number): { status: 'processed' | 'review' | 'ignored'; stopped: boolean } {
  const actor = inboundActor(row.id);
  const recipient = correlation ? enrollmentRecipient(db, correlation.enrollmentId) : undefined;
  if (cls === 'delivery') return { status: 'ignored', stopped: false };
  if (cls === 'unknown') return { status: 'review', stopped: false };

  if (cls === 'complaint' || cls === 'opt_out') {
    const address = (recipient?.email ?? event.from).toLowerCase();
    addSuppression(db, { workspaceId: row.workspace_id, scope: 'global', value: address, reason: cls === 'complaint' ? 'complaint' : 'opt_out', source: `event:${row.id}` }, now);
    const contactId = recipient?.contactId ?? db.prepare(`SELECT contact_id FROM contact_points WHERE workspace_id = ? AND kind = 'email' AND value_norm = ?`).get<{ contact_id: string }>(row.workspace_id, address)?.contact_id;
    let stopped = false;
    for (const enrollment of contactId ? liveEnrollmentsForContact(db, row.workspace_id, contactId) : []) {
      stopped = stopEnrollment(db, enrollment.id, 'opted_out', cls, actor, now) || stopped;
    }
    if (cls === 'complaint') {
      setKillSwitch(db, { workspaceId: row.workspace_id, scope: 'provider_account', targetId: row.provider_account_id, engaged: true, reason: 'complaint_received' }, actor, now);
    }
    return { status: correlation?.strength === 'weak' ? 'review' : 'processed', stopped };
  }

  if (!correlation) return { status: cls === 'auto_reply' ? 'ignored' : 'review', stopped: false };
  if (cls === 'auto_reply') return { status: 'processed', stopped: false };

  if (cls === 'hard_bounce' || cls === 'soft_bounce') {
    const softCount = cls === 'soft_bounce'
      ? (db.prepare(`SELECT COUNT(*) AS n FROM provider_events WHERE enrollment_id = ? AND class = 'soft_bounce' AND id <> ?`).get<{ n: number }>(correlation.enrollmentId, row.id)?.n ?? 0) + 1
      : 0;
    if (cls === 'soft_bounce' && softCount < SOFT_BOUNCES_BEFORE_STOP) return { status: 'processed', stopped: false };
    if (recipient) addSuppression(db, { workspaceId: row.workspace_id, scope: 'channel', channel: 'email', value: recipient.email, reason: 'hard_bounce', source: `event:${row.id}` }, now);
    return { status: 'processed', stopped: stopEnrollment(db, correlation.enrollmentId, 'bounced', cls, actor, now) };
  }

  // A human reply. A weak (address-only) match still stops — the safe direction — but a person confirms.
  const stopped = stopEnrollment(db, correlation.enrollmentId, 'replied', `reply:${correlation.via}`, actor, now);
  return { status: correlation.strength === 'weak' ? 'review' : 'processed', stopped };
}

/**
 * Processes stored inbound events, oldest first, each in its own transaction: classify, correlate,
 * record the inbound message, stop or suppress atomically, notify, and audit.
 */
export function processInboundEvents(env: DomainEnv, limit = 200): ProcessReport {
  const rows = env.db
    .prepare(`SELECT id, workspace_id, provider_account_id, provider_event_id, payload FROM provider_events WHERE status = 'pending' ORDER BY received_at, id LIMIT ?`)
    .all<EventRow>(limit);
  let stopped = 0;
  let toReview = 0;
  let ignored = 0;
  for (const row of rows) {
    env.db.transaction(() => {
      const now = env.now();
      const event = JSON.parse(row.payload) as InboundMailEvent;
      const cls = classifyInbound(event);
      const correlation = correlateInbound(env.db, row.workspace_id, row.provider_account_id, event);
      recordInboundMessage(env.db, row, event, correlation?.enrollmentId ?? null, now);
      const result = apply(env.db, row, event, cls, correlation, now);
      env.db.prepare('UPDATE provider_events SET status = ?, class = ?, correlation = ?, enrollment_id = ?, processed_at = ? WHERE id = ?')
        .run(result.status, cls, correlation ? `${correlation.strength}:${correlation.via}` : 'none', correlation?.enrollmentId ?? null, now, row.id);
      if (result.status !== 'ignored') notify(env.db, row, cls, correlation, event, now);
      appendAudit(env.db, {
        workspaceId: row.workspace_id, at: now, actorKind: 'provider', actorId: 'inbound', source: 'inbound', traceId: row.id,
        resourceKind: 'provider_event', resourceId: row.id, action: `classified:${cls}`,
        detail: { status: result.status, correlation: correlation ? `${correlation.strength}:${correlation.via}` : 'none', stopped: result.stopped },
      });
      if (result.stopped) stopped += 1;
      if (result.status === 'review') toReview += 1;
      if (result.status === 'ignored') ignored += 1;
    });
  }
  return { processed: rows.length, stopped, toReview, ignored };
}
