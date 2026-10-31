import type { SqlDatabase } from '@splitin/outreach-contracts';
import type { NormalizedContact } from './normalize';

export type RowOutcome = 'create' | 'update' | 'merge' | 'reject' | 'ambiguous';

export interface ResolvedRow {
  readonly outcome: RowOutcome;
  /** For merge: the ordinal of the earlier row in this file with the same identity. */
  readonly mergeInto?: number;
  /** For update/ambiguous: the existing contact. */
  readonly existingContactId?: string;
  readonly note?: string;
}

export interface ResolvableRow {
  readonly ordinal: number;
  readonly contact: NormalizedContact;
  readonly errors: readonly string[];
}

/**
 * Deterministic duplicate resolution with explainable rules:
 * 1. rows with errors are rejected;
 * 2. an email (or, without email, a profile URL) seen earlier in the file merges into that row;
 * 3. an email or profile URL already in the workspace updates that contact;
 * 4. same name at the same organization domain under a different email is ambiguous: never auto-merged;
 * 5. everything else creates a contact.
 */
export function resolveRows(db: SqlDatabase, workspaceId: string, rows: readonly ResolvableRow[]): ResolvedRow[] {
  const firstByKey = new Map<string, number>();
  const pointLookup = db.prepare('SELECT contact_id FROM contact_points WHERE workspace_id = ? AND kind = ? AND value_norm = ?');
  const nameLookup = db.prepare(
    `SELECT c.id FROM contacts c JOIN organizations o ON o.id = c.organization_id
     WHERE c.workspace_id = ? AND lower(c.full_name) = lower(?) AND o.domain_norm = ? AND c.merged_into_id IS NULL LIMIT 1`,
  );
  return rows.map((row): ResolvedRow => {
    if (row.errors.length) return { outcome: 'reject', note: row.errors.join('; ') };
    const { email, profile_url: profileUrl } = row.contact;
    const key = email ? `email:${email}` : profileUrl ? `profile:${profileUrl}` : null;
    if (key) {
      const earlier = firstByKey.get(key);
      if (earlier !== undefined) return { outcome: 'merge', mergeInto: earlier, note: `same ${key.split(':')[0]} as an earlier row` };
      firstByKey.set(key, row.ordinal);
    }
    const existing =
      (email ? pointLookup.get<{ contact_id: string }>(workspaceId, 'email', email) : undefined) ??
      (profileUrl ? pointLookup.get<{ contact_id: string }>(workspaceId, 'social_profile', profileUrl) : undefined);
    if (existing) return { outcome: 'update', existingContactId: existing.contact_id };
    if (row.contact.full_name && row.contact.org_domain) {
      const similar = nameLookup.get<{ id: string }>(workspaceId, row.contact.full_name, row.contact.org_domain);
      if (similar) return { outcome: 'ambiguous', existingContactId: similar.id, note: 'same name and organization as an existing contact with a different email' };
    }
    return { outcome: 'create' };
  });
}
