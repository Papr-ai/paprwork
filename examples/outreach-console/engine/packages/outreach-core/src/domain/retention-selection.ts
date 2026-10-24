import { sha256Hex, type SqlDatabase } from '@splitin/outreach-contracts';
import { normalizeEmail } from './suppressions';

export interface RetentionPolicy { readonly days: number; readonly cutoff: number; readonly limit: number; readonly afterId: string }
type Row = Record<string, unknown>;
export interface RetentionContact {
  readonly contact: Row;
  readonly retained: { pruned_at: number } | null;
  readonly points: Row[];
  readonly suppressions: Row[];
  readonly enrollments: Row[];
  readonly actions: Row[];
  readonly attempts: Row[];
  readonly messages: Row[];
  readonly events: Row[];
  readonly tasks: Row[];
  readonly imports: Row[];
}
const rows = (db: SqlDatabase, sql: string, ...args: string[]) => db.prepare(sql).all<Row>(...args);
function byIds(db: SqlDatabase, table: string, column: string, ids: string[]): Row[] {
  if (!ids.length) return [];
  // Table and column are internal constants, never user input.
  return rows(db, `SELECT * FROM ${table} WHERE ${column} IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids);
}
function historyRows(db: SqlDatabase, table: string, workspaceId: string): Row[] {
  const result = rows(db, `SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY id LIMIT 10001`, workspaceId);
  if (result.length > 10000) throw new Error('Retention history scan exceeds 10000 rows per table; use reviewed offline tooling rather than an unbounded writer lock');
  return result;
}
function addressIndex(items: Row[]): Map<string, Row[]> {
  const index = new Map<string, Row[]>();
  for (const row of items) {
    if (typeof row.recipient_norm !== 'string') continue;
    const address = normalizeEmail(row.recipient_norm);
    const group = index.get(address) ?? []; group.push(row); index.set(address, group);
  }
  return index;
}
function byAddresses(index: Map<string, Row[]>, emails: Row[]): Row[] {
  return emails.flatMap((p) => index.get(normalizeEmail(String(p.value_norm))) ?? []);
}
function relatedEvents(all: Row[], emails: Row[], messages: Row[], enrollments: Row[]): Row[] {
  const addresses = new Set(emails.map((p) => normalizeEmail(String(p.value_norm))));
  return all.filter((row) => {
    if (enrollments.some((e) => e.id === row.enrollment_id)) return true;
    const event = JSON.parse(String(row.payload)) as { from?: string; providerThreadId?: string; inReplyTo?: string; references?: string[]; dsn?: { recipient?: string; originalMessageId?: string } };
    if ([event.from, event.dsn?.recipient].some((a) => typeof a === 'string' && addresses.has(normalizeEmail(a)))) return true;
    const references = [event.inReplyTo, event.dsn?.originalMessageId, ...(Array.isArray(event.references) ? event.references : [])];
    return messages.some((m) => (event.providerThreadId && m.provider_account_id === row.provider_account_id && m.provider_thread_id === event.providerThreadId)
      || (m.rfc_message_id && references.includes(String(m.rfc_message_id))));
  });
}
const ids = (items: Row[]) => items.map((r) => String(r.id));
const recent = (items: Row[], field: string, cutoff: number) => items.some((r) => Number(r[field]) > cutoff);

function hasNewPii(contact: Row, points: Row[], actions: Row[], attempts: Row[], messages: Row[], events: Row[], tasks: Row[], imports: Row[]): boolean {
  return contact.full_name !== '[pruned]' || contact.first_name !== null || contact.attributes !== '{}'
    || ['title', 'timezone', 'locale', 'organization_id'].some((key) => contact[key] !== null)
    || points.some((p) => p.source !== 'retention-v1' || p.kind !== 'other' || p.value_norm !== `retained-contact-point:${p.id}`
      || p.value_raw !== '' || p.permitted_channels !== '[]'
      || ['consent_basis', 'consent_evidence', 'consent_at', 'jurisdiction'].some((key) => p[key] !== null))
    || actions.some((a) => a.payload !== '{"retained":true}' || a.recipient_norm !== null || a.state_reason !== 'retention_pruned')
    || attempts.some((a) => a.error_detail !== null || a.receipt !== null)
    || messages.some((m) => m.from_addr !== '' || m.to_addrs !== '[]' || m.subject !== null || m.recipient_norm !== null)
    || events.some((e) => e.payload !== '{"retained":true}' || e.detail !== null)
    || tasks.some((t) => t.draft_text !== '' || t.target_url !== null || t.note !== null)
    || imports.some((r) => r.raw !== '{}' || r.normalized !== null || r.errors !== '[]' || r.locator !== '[pruned]');
}

/** Conservative opt-out-only scope. Does not change data or select uncertain operational records. */
export function selectRetention(db: SqlDatabase, workspaceId: string, policy: RetentionPolicy): { contacts: RetentionContact[]; scanned: number; nextAfterId: string | null } {
  // An unresolved event can acquire a contact association later. Do not prune while any exist.
  const allEvents = historyRows(db, 'provider_events', workspaceId);
  if (allEvents.some((e) => !['processed', 'ignored'].includes(String(e.status)))) return { contacts: [], scanned: 0, nextAfterId: null };
  const actionIndex = addressIndex(historyRows(db, 'scheduled_actions', workspaceId));
  const messageIndex = addressIndex(historyRows(db, 'messages', workspaceId));
  const candidates = db.prepare(`SELECT * FROM contacts c WHERE c.workspace_id = ? AND c.updated_at <= ?
    AND c.merged_into_id IS NULL AND NOT EXISTS (SELECT 1 FROM contacts m WHERE m.merged_into_id = c.id)
    AND c.id > ? ORDER BY c.id LIMIT 1000`).all<Row>(workspaceId, policy.cutoff, policy.afterId);
  const selected: RetentionContact[] = [];
  let scanned = 0; let nextAfterId: string | null = null;
  for (const contact of candidates) {
    if (selected.length >= policy.limit) break;
    scanned += 1; nextAfterId = String(contact.id);
    const points = rows(db, 'SELECT * FROM contact_points WHERE workspace_id = ? AND contact_id = ? ORDER BY id', workspaceId, String(contact.id));
    const emails = points.filter((p) => p.kind === 'email');
    const retained = db.prepare('SELECT pruned_at FROM retained_contacts WHERE workspace_id = ? AND contact_id = ?').get<{ pruned_at: number }>(workspaceId, String(contact.id));
    if ((!emails.length && !retained) || (retained && retained.pruned_at > policy.cutoff)) continue;
    const suppressions: Row[] = [];
    for (const point of emails) {
      const suppression = db.prepare(`SELECT * FROM suppressions WHERE workspace_id = ? AND scope = 'global'
        AND channel = '*' AND value_norm = ? AND reason = 'opt_out' AND effective_at <= ?`).get<Row>(workspaceId, normalizeEmail(String(point.value_norm)), policy.cutoff);
      const fingerprint = suppression ? undefined : db.prepare("SELECT * FROM suppression_fingerprints WHERE workspace_id = ? AND scheme = 'sha256-email-v1' AND digest = ? AND effective_at <= ?")
        .get<Row>(workspaceId, sha256Hex(normalizeEmail(String(point.value_norm))), policy.cutoff);
      if (suppression) suppressions.push(suppression);
      else if (fingerprint) suppressions.push({ ...fingerprint, value_norm: normalizeEmail(String(point.value_norm)) });
    }
    if (suppressions.length !== emails.length) continue;
    const enrollments = rows(db, 'SELECT * FROM enrollments WHERE workspace_id = ? AND contact_id = ? ORDER BY id', workspaceId, String(contact.id));
    if (enrollments.some((e) => ['active', 'paused'].includes(String(e.status))) || recent(enrollments, 'updated_at', policy.cutoff)) continue;
    const actions = [...new Map([...byIds(db, 'scheduled_actions', 'enrollment_id', ids(enrollments)),
      ...byIds(db, 'scheduled_actions', 'contact_point_id', ids(points)), ...byAddresses(actionIndex, emails)].map((a) => [a.id, a])).values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (actions.some((a) => !['succeeded', 'failed', 'cancelled'].includes(String(a.state))) || recent(actions, 'updated_at', policy.cutoff)) continue;
    const attempts = byIds(db, 'action_attempts', 'action_id', ids(actions));
    if (attempts.some((a) => ['pending', 'uncertain'].includes(String(a.outcome))) || recent(attempts, 'finished_at', policy.cutoff)) continue;
    const messages = [...new Map([...byIds(db, 'messages', 'enrollment_id', ids(enrollments)), ...byIds(db, 'messages', 'action_id', ids(actions)), ...byAddresses(messageIndex, emails)]
      .map((m) => [m.id, m])).values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const events = relatedEvents(allEvents, emails, messages, enrollments);
    if (events.some((e) => !['processed', 'ignored'].includes(String(e.status))) || recent(events, 'received_at', policy.cutoff) || recent(events, 'processed_at', policy.cutoff) || recent(messages, 'at', policy.cutoff)) continue;
    const tasks = byIds(db, 'manual_tasks', 'action_id', ids(actions));
    if (tasks.some((t) => t.status === 'open') || recent(tasks, 'confirmed_at', policy.cutoff)) continue;
    const imports = rows(db, `SELECT r.*, b.created_at AS batch_created_at, b.committed_at AS batch_committed_at FROM import_rows r JOIN import_batches b ON b.id = r.batch_id
      WHERE b.workspace_id = ? AND r.contact_id = ? ORDER BY r.id`, workspaceId, String(contact.id));
    if (recent(imports, 'batch_created_at', policy.cutoff) || recent(imports, 'batch_committed_at', policy.cutoff)) continue;
    // Already-minimized identities can receive new linked mail later. Revisit only actual new PII,
    // retaining the original tombstones without reconstructing the address from its fingerprint.
    if (retained && !hasNewPii(contact, points, actions, attempts, messages, events, tasks, imports)) continue;
    selected.push({ contact, retained: retained ?? null, points, suppressions, enrollments, actions, attempts, messages, events, tasks, imports });
  }
  return { contacts: selected, scanned, nextAfterId };
}
