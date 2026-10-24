import { digestCanonical, sha256Hex, ulid } from '@splitin/outreach-contracts';
import { ConflictError, ForbiddenError, audit, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import { normalizeEmail } from './suppressions';
import { selectRetention, type RetentionContact, type RetentionPolicy } from './retention-selection';

export const RETENTION_LIMITS = { maxBatch: 100, maxScanned: 1000, previewTtlMs: 15 * 60_000 } as const;
export interface RetentionInput { readonly days: number; readonly limit?: number; readonly afterId?: string }
export interface RetentionPreview {
  readonly id: string; readonly operationHash: string; readonly expiresAt: number;
  readonly policy: RetentionPolicy; readonly contactIds: string[];
  readonly counts: Record<string, number>; readonly scanned: number; readonly nextAfterId: string | null; readonly exclusions: readonly string[];
}
const EXCLUSIONS = ['immutable audit history', 'shared approval/prepared previews and rate-limit/reservation metadata', 'unlinked or free-text copies and non-opt-out suppression records', 'provider mailboxes', 'external exports and previous backups'] as const;
function currentAdmin(env: DomainEnv, ctx: AuthContext): void {
  requireRole(ctx, 'admin');
  const principal = env.db.prepare('SELECT roles FROM principals WHERE workspace_id = ? AND id = ?').get<{ roles: string }>(ctx.workspaceId, ctx.principalId);
  if (!principal || !(JSON.parse(principal.roles) as string[]).includes('admin')) throw new ForbiddenError('current admin role required');
}
function counts(contacts: RetentionContact[]): Record<string, number> {
  const result: Record<string, number> = { contacts: contacts.length };
  for (const key of ['points', 'actions', 'attempts', 'messages', 'events', 'tasks', 'imports'] as const) result[key] = contacts.reduce((n, c) => n + c[key].length, 0);
  return result;
}
function digest(ctx: AuthContext, id: string, policy: RetentionPolicy, expiresAt: number, selected: ReturnType<typeof selectRetention>): string {
  return digestCanonical({ scheme: 'contact-retention-v1', workspaceId: ctx.workspaceId, principalId: ctx.principalId, id, policy, expiresAt, selected });
}
/** Preview writes only an opaque approval envelope and audit record; no contact data is pruned. */
export function prepareRetention(env: DomainEnv, ctx: AuthContext, input: RetentionInput): RetentionPreview {
  currentAdmin(env, ctx);
  if (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > 36500) throw new Error('Explicit retention days must be an integer from 1 to 36500');
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Retention batch limit must be 1 to 100');
  return env.db.transaction(() => {
    currentAdmin(env, ctx);
    const now = env.now(); const id = ulid(now); const expiresAt = now + RETENTION_LIMITS.previewTtlMs;
    const policy = { days: input.days, cutoff: now - input.days * 86_400_000, limit, afterId: input.afterId ?? '' };
    const selected = selectRetention(env.db, ctx.workspaceId, policy);
    const operationHash = digest(ctx, id, policy, expiresAt, selected);
    env.db.prepare('INSERT INTO retention_previews (id, workspace_id, principal_id, policy, operation_hash, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, ctx.workspaceId, ctx.principalId, JSON.stringify(policy), operationHash, now, expiresAt);
    audit(env.db, ctx, now, 'retention', id, 'previewed', { operationHash, policy, counts: counts(selected.contacts) });
    return { id, operationHash, expiresAt, policy, contactIds: selected.contacts.map((s) => String(s.contact.id)), counts: counts(selected.contacts), scanned: selected.scanned, nextAfterId: selected.nextAfterId, exclusions: EXCLUSIONS };
  });
}
function prune(env: DomainEnv, ctx: AuthContext, selected: RetentionContact[], now: number): void {
  const db = env.db;
  for (const item of selected) {
    for (const suppression of item.suppressions) {
      db.prepare(`INSERT INTO suppression_fingerprints (workspace_id, scheme, digest, reason, effective_at)
        VALUES (?, 'sha256-email-v1', ?, 'opt_out', ?) ON CONFLICT DO NOTHING`)
        .run(ctx.workspaceId, sha256Hex(normalizeEmail(String(suppression.value_norm))), Number(suppression.effective_at));
      if (suppression.id) db.prepare('DELETE FROM suppressions WHERE id = ? AND workspace_id = ?').run(String(suppression.id), ctx.workspaceId);
    }
    db.prepare(`UPDATE contacts SET full_name = '[pruned]', first_name = NULL, title = NULL, timezone = NULL,
      locale = NULL, organization_id = NULL, attributes = '{}', updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(now, String(item.contact.id), ctx.workspaceId);
    // Keep FK identities, but no contact address is left in these operational records.
    for (const point of item.points) db.prepare(`UPDATE contact_points SET kind = 'other', value_norm = ?, value_raw = '',
      source = 'retention-v1', consent_basis = NULL, consent_evidence = NULL, consent_at = NULL, jurisdiction = NULL,
      permitted_channels = '[]' WHERE id = ? AND workspace_id = ?`).run(`retained-contact-point:${point.id}`, String(point.id), ctx.workspaceId);
    for (const row of item.imports) db.prepare(`UPDATE import_rows SET raw = '{}', normalized = NULL, errors = '[]', locator = '[pruned]' WHERE id = ?`).run(String(row.id));
    for (const row of item.actions) db.prepare(`UPDATE scheduled_actions SET recipient_norm = NULL, payload = '{"retained":true}', state_reason = 'retention_pruned' WHERE id = ?`).run(String(row.id));
    for (const row of item.attempts) db.prepare('UPDATE action_attempts SET error_detail = NULL, receipt = NULL WHERE id = ?').run(String(row.id));
    for (const row of item.messages) db.prepare(`UPDATE messages SET from_addr = '', to_addrs = '[]', recipient_norm = NULL, subject = NULL WHERE id = ?`).run(String(row.id));
    for (const row of item.events) db.prepare(`UPDATE provider_events SET payload = '{"retained":true}', detail = NULL WHERE id = ?`).run(String(row.id));
    for (const row of item.tasks) db.prepare(`UPDATE manual_tasks SET target_url = NULL, draft_text = '', note = NULL WHERE id = ?`).run(String(row.id));
    db.prepare('INSERT INTO retained_contacts (workspace_id, contact_id, pruned_at) VALUES (?,?,?) ON CONFLICT (workspace_id, contact_id) DO UPDATE SET pruned_at = excluded.pruned_at').run(ctx.workspaceId, String(item.contact.id), now);
  }
}
/** Destructive: only call after a trusted operator explicitly confirms this exact preview hash. */
export function commitRetention(env: DomainEnv, ctx: AuthContext, id: string, confirmedHash: string): { contacts: number } {
  return env.db.transaction(() => {
    currentAdmin(env, ctx);
    const row = env.db.prepare('SELECT * FROM retention_previews WHERE id = ? AND workspace_id = ? AND principal_id = ?')
      .get<{ policy: string; operation_hash: string; expires_at: number; committed_at: number | null }>(id, ctx.workspaceId, ctx.principalId);
    if (!row || row.committed_at !== null || env.now() >= row.expires_at) throw new ConflictError('Retention preview missing, expired or already consumed');
    const policy = JSON.parse(row.policy) as RetentionPolicy;
    const selected = selectRetention(env.db, ctx.workspaceId, policy);
    if (row.operation_hash !== confirmedHash || digest(ctx, id, policy, row.expires_at, selected) !== confirmedHash) throw new ConflictError('Retention preview changed; review a fresh preview');
    prune(env, ctx, selected.contacts, env.now());
    env.db.prepare('UPDATE retention_previews SET committed_at = ? WHERE id = ?').run(env.now(), id);
    audit(env.db, ctx, env.now(), 'retention', id, 'committed', { operationHash: confirmedHash, counts: counts(selected.contacts), exclusions: EXCLUSIONS });
    return { contacts: selected.contacts.length };
  });
}
