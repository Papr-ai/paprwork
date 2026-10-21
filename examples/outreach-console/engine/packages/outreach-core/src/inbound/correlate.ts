import type { InboundMailEvent, SqlDatabase } from '@splitin/outreach-contracts';

export interface Correlation {
  readonly enrollmentId: string;
  /** strong: provider thread or Message-ID chain; weak: same address within 30 days only. */
  readonly strength: 'strong' | 'weak';
  readonly via: 'thread' | 'message_id' | 'recipient';
}

const WEAK_WINDOW_MS = 30 * 86_400_000;

/**
 * Correlates an inbound event with the enrollment it answers (BUILD_PLAN.md §8.3), in order of trust:
 * provider thread id, then In-Reply-To/References/DSN original id against our Message-IDs, then the
 * sender (or bounced recipient) matching a recent outbound recipient.
 */
export function correlateInbound(db: SqlDatabase, workspaceId: string, providerAccountId: string, event: InboundMailEvent): Correlation | null {
  if (event.providerThreadId) {
    const row = db
      .prepare(
        `SELECT enrollment_id FROM messages WHERE provider_account_id = ? AND provider_thread_id = ? AND direction = 'outbound'
         AND enrollment_id IS NOT NULL ORDER BY at DESC LIMIT 1`,
      )
      .get<{ enrollment_id: string }>(providerAccountId, event.providerThreadId);
    if (row) return { enrollmentId: row.enrollment_id, strength: 'strong', via: 'thread' };
  }
  const ids = [...new Set([event.inReplyTo, ...event.references, event.dsn?.originalMessageId].filter((id): id is string => !!id))].slice(0, 50);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const row = db
      .prepare(
        `SELECT enrollment_id FROM messages WHERE workspace_id = ? AND direction = 'outbound' AND enrollment_id IS NOT NULL
         AND rfc_message_id IN (${placeholders}) ORDER BY at DESC LIMIT 1`,
      )
      .get<{ enrollment_id: string }>(workspaceId, ...ids);
    if (row) return { enrollmentId: row.enrollment_id, strength: 'strong', via: 'message_id' };
  }
  const address = (event.kind === 'bounce' ? event.dsn?.recipient : event.from)?.trim().toLowerCase();
  if (address) {
    const row = db
      .prepare(
        `SELECT enrollment_id FROM messages WHERE workspace_id = ? AND direction = 'outbound' AND recipient_norm = ?
         AND enrollment_id IS NOT NULL AND at >= ? ORDER BY at DESC LIMIT 1`,
      )
      .get<{ enrollment_id: string }>(workspaceId, address, event.receivedAt - WEAK_WINDOW_MS);
    if (row) return { enrollmentId: row.enrollment_id, strength: 'weak', via: 'recipient' };
  }
  return null;
}
