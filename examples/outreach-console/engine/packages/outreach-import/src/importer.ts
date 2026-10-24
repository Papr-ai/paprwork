import { appendAudit, digestCanonical, sha256Hex, ulid, type SqlDatabase } from '@splitin/outreach-contracts';
import { DEFAULT_LIMITS, ImportRejectedError, decodeText, detectFormat, type ImportFormat, type ImportLimits, type RawRow } from './detect';
import { parseHtmlCards, parseHtmlTable } from './html';
import { normalizeRow, type NormalizedContact } from './normalize';
import { parseDelimited, parseJson, parseXlsx } from './parsers';
import { loadMappingProfile, type MappingProfile } from './profile';
import { resolveRows, type ResolvedRow, type RowOutcome } from './resolve';

/** Who is importing; always supplied by the calling surface from its authenticated context. */
export interface ImportActor {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly source: string;
  readonly traceId: string;
}

export interface PreviewInput {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly profileId: string;
  readonly limits?: Partial<ImportLimits>;
  readonly now: number;
}

export interface PreviewSample {
  readonly ordinal: number;
  readonly locator: string;
  readonly contact: NormalizedContact;
  readonly note?: string;
}

export interface ImportPreview {
  readonly batchId: string;
  readonly previewHash: string;
  readonly format: ImportFormat;
  readonly counts: Record<RowOutcome, number>;
  readonly warnings: readonly string[];
  readonly samples: Record<RowOutcome, readonly PreviewSample[]>;
}

async function parseRows(bytes: Uint8Array, format: ImportFormat, profile: MappingProfile, limits: ImportLimits): Promise<{ rows: RawRow[]; warnings: string[] }> {
  if (format === 'xlsx') return { rows: await parseXlsx(bytes, limits.maxRows, profile.sheet), warnings: [] };
  const { text, warnings } = decodeText(bytes);
  if (format === 'json') return { rows: parseJson(text, limits.maxRows), warnings };
  if (format === 'csv') return { rows: parseDelimited(text, limits.maxRows, profile.delimiter), warnings };
  const html = profile.html ?? { mode: 'table' as const, table: 0 };
  const rows = html.mode === 'table' ? parseHtmlTable(text, html.table, limits.maxRows) : parseHtmlCards(text, html.card, html.fields, limits.maxRows);
  return { rows, warnings };
}

function audit(db: SqlDatabase, actor: ImportActor, now: number, batchId: string, action: string, detail: unknown): void {
  appendAudit(db, { workspaceId: actor.workspaceId, at: now, actorKind: 'principal', actorId: actor.principalId, source: actor.source, traceId: actor.traceId, resourceKind: 'import_batch', resourceId: batchId, action, detail });
}

function hashPreview(sourceSha: string, profileId: string, rows: readonly { contact: NormalizedContact; resolved: ResolvedRow }[]): string {
  return digestCanonical({ sourceSha, profileId, rows: rows.map((row) => [row.resolved.outcome, row.resolved.mergeInto ?? null, row.resolved.existingContactId ?? null, row.contact]) });
}

/** Parses inertly, normalizes, resolves duplicates and stages everything. Creates no contacts. */
export async function previewImport(db: SqlDatabase, actor: ImportActor, input: PreviewInput): Promise<ImportPreview> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  if (input.bytes.byteLength > limits.maxBytes) throw new ImportRejectedError(`file is larger than ${limits.maxBytes} bytes`);
  const stored = loadMappingProfile(db, actor.workspaceId, input.profileId);
  if (!stored) throw new ImportRejectedError(`mapping profile ${input.profileId} not found`);
  const format = detectFormat(input.bytes, input.fileName, stored.spec.format);
  const { rows, warnings } = await parseRows(input.bytes, format, stored.spec, limits);
  const normalized = rows.map((row, ordinal) => ({ ordinal, row, ...normalizeRow(row, stored.spec) }));
  const sourceSha = sha256Hex(input.bytes);

  return db.transaction(() => {
    const resolved = resolveRows(db, actor.workspaceId, normalized);
    const joined = normalized.map((row, i) => ({ ...row, resolved: resolved[i] as ResolvedRow }));
    const counts: Record<RowOutcome, number> = { create: 0, update: 0, merge: 0, reject: 0, ambiguous: 0 };
    const samples: Record<RowOutcome, PreviewSample[]> = { create: [], update: [], merge: [], reject: [], ambiguous: [] };
    for (const row of joined) {
      counts[row.resolved.outcome] += 1;
      const bucket = samples[row.resolved.outcome];
      if (bucket.length < 20) bucket.push({ ordinal: row.ordinal, locator: row.row.locator, contact: row.contact, ...(row.resolved.note ? { note: row.resolved.note } : {}) });
    }
    const previewHash = hashPreview(sourceSha, stored.id, joined);
    const batchId = ulid(input.now);
    db.prepare(
      `INSERT INTO import_batches (id, workspace_id, source_name, source_sha256, format, mapping_profile_id, status, preview_hash, counts, warnings, created_by, created_at)
       VALUES (?,?,?,?,?,?,'previewed',?,?,?,?,?)`,
    ).run(batchId, actor.workspaceId, input.fileName.slice(0, 200), sourceSha, format, stored.id, previewHash, JSON.stringify(counts), JSON.stringify(warnings), actor.principalId, input.now);
    const insert = db.prepare('INSERT INTO import_rows (id, batch_id, ordinal, locator, raw, normalized, outcome, errors, contact_id) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const row of joined) {
      insert.run(ulid(input.now), batchId, row.ordinal, row.row.locator, JSON.stringify(row.row.values), JSON.stringify({ contact: row.contact, resolved: row.resolved }), row.resolved.outcome, JSON.stringify(row.errors), row.resolved.existingContactId ?? null);
    }
    audit(db, actor, input.now, batchId, 'previewed', { counts, format, sourceSha });
    return { batchId, previewHash, format, counts, warnings, samples };
  });
}

export class ImportStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportStaleError';
  }
}

export interface CommitResult {
  readonly batchId: string;
  readonly created: number;
  readonly updated: number;
  readonly merged: number;
  readonly skipped: number;
  readonly alreadyCommitted: boolean;
}

interface StagedRow {
  id: string;
  ordinal: number;
  normalized: string;
  errors: string;
  outcome: RowOutcome;
}

/**
 * Commits exactly the previewed outcome. Outcomes are recomputed against the current workspace; any
 * difference means the preview is stale and nothing is written. Never enrolls anyone or sends anything.
 */
export function commitImport(db: SqlDatabase, actor: ImportActor, input: { batchId: string; previewHash: string; idempotencyKey: string; now: number }): CommitResult {
  return db.transaction(() => {
    const batch = db.prepare('SELECT * FROM import_batches WHERE workspace_id = ? AND id = ?')
      .get<{ id: string; status: string; preview_hash: string; idempotency_key: string | null; counts: string; mapping_profile_id: string }>(actor.workspaceId, input.batchId);
    if (!batch) throw new ImportRejectedError(`import batch ${input.batchId} not found`);
    if (batch.preview_hash !== input.previewHash) throw new ImportStaleError('preview hash does not match this batch');
    if (batch.status === 'committed') {
      if (batch.idempotency_key !== input.idempotencyKey) throw new ImportStaleError('batch was already committed with a different idempotency key');
      const counts = JSON.parse(batch.counts) as Record<RowOutcome, number>;
      return { batchId: batch.id, created: counts.create, updated: counts.update, merged: counts.merge, skipped: counts.reject + counts.ambiguous, alreadyCommitted: true };
    }
    if (batch.status !== 'previewed') throw new ImportStaleError(`batch is ${batch.status}`);
    const profile = loadMappingProfile(db, actor.workspaceId, batch.mapping_profile_id);
    if (!profile) throw new ImportRejectedError('mapping profile vanished');

    const staged = db.prepare('SELECT id, ordinal, normalized, errors, outcome FROM import_rows WHERE batch_id = ? ORDER BY ordinal').all<StagedRow>(batch.id);
    const rows = staged.map((row) => ({ ordinal: row.ordinal, contact: (JSON.parse(row.normalized) as { contact: NormalizedContact }).contact, errors: JSON.parse(row.errors) as string[] }));
    const now = resolveRows(db, actor.workspaceId, rows);
    const drift = staged.findIndex((row, i) => row.outcome !== now[i]?.outcome || (JSON.parse(row.normalized) as { resolved: ResolvedRow }).resolved.existingContactId !== now[i]?.existingContactId);
    if (drift !== -1) throw new ImportStaleError(`workspace changed since the preview (row ${drift + 1}); preview again`);

    const contactByOrdinal = new Map<number, string>();
    let created = 0;
    let updated = 0;
    let merged = 0;
    staged.forEach((row, i) => {
      const resolved = now[i] as ResolvedRow;
      const contact = (rows[i] as { contact: NormalizedContact }).contact;
      let contactId: string | null = null;
      if (resolved.outcome === 'create') {
        contactId = createContact(db, actor.workspaceId, contact, profile.spec, batch.id, input.now);
        created += 1;
      } else if (resolved.outcome === 'update' && resolved.existingContactId) {
        contactId = resolved.existingContactId;
        updateContact(db, actor.workspaceId, contactId, contact, profile.spec, batch.id, input.now);
        updated += 1;
      } else if (resolved.outcome === 'merge' && resolved.mergeInto !== undefined) {
        contactId = contactByOrdinal.get(resolved.mergeInto) ?? null;
        merged += 1;
      }
      if (contactId) {
        contactByOrdinal.set(row.ordinal, contactId);
        db.prepare('UPDATE import_rows SET contact_id = ? WHERE id = ?').run(contactId, row.id);
      }
    });
    db.prepare(`UPDATE import_batches SET status = 'committed', idempotency_key = ?, committed_at = ? WHERE id = ?`).run(input.idempotencyKey, input.now, batch.id);
    const skipped = staged.length - created - updated - merged;
    audit(db, actor, input.now, batch.id, 'committed', { created, updated, merged, skipped });
    return { batchId: batch.id, created, updated, merged, skipped, alreadyCommitted: false };
  });
}

function organizationFor(db: SqlDatabase, workspaceId: string, contact: NormalizedContact, now: number): string | null {
  if (!contact.org_name && !contact.org_domain) return null;
  const existing = contact.org_domain
    ? db.prepare('SELECT id FROM organizations WHERE workspace_id = ? AND domain_norm = ?').get<{ id: string }>(workspaceId, contact.org_domain)
    : db.prepare('SELECT id FROM organizations WHERE workspace_id = ? AND domain_norm IS NULL AND lower(name) = lower(?)').get<{ id: string }>(workspaceId, contact.org_name ?? '');
  if (existing) return existing.id;
  const id = ulid(now);
  db.prepare('INSERT INTO organizations (id, workspace_id, name, domain_norm) VALUES (?,?,?,?)').run(id, workspaceId, contact.org_name ?? contact.org_domain ?? '', contact.org_domain);
  return id;
}

function addPoint(db: SqlDatabase, workspaceId: string, contactId: string, kind: string, value: string, profile: MappingProfile, country: string | null, source: string, now: number): void {
  db.prepare(
    `INSERT INTO contact_points (id, workspace_id, contact_id, kind, value_norm, value_raw, source, consent_basis, consent_evidence, consent_at, jurisdiction, permitted_channels)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (workspace_id, kind, value_norm) DO UPDATE SET jurisdiction = excluded.jurisdiction
       WHERE coalesce(contact_points.jurisdiction, 'unknown') = 'unknown' AND excluded.jurisdiction <> 'unknown'`,
  ).run(ulid(now), workspaceId, contactId, kind, value, value, source, profile.consent.basis, profile.consent.evidence ?? null, now, country ?? profile.jurisdiction, JSON.stringify(kind === 'email' ? ['email'] : []));
}

function createContact(db: SqlDatabase, workspaceId: string, contact: NormalizedContact, profile: MappingProfile, batchId: string, now: number): string {
  const id = ulid(now);
  db.prepare(
    `INSERT INTO contacts (id, workspace_id, organization_id, full_name, first_name, title, timezone, locale, attributes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, workspaceId, organizationFor(db, workspaceId, contact, now), contact.full_name ?? contact.email ?? contact.profile_url ?? 'Unknown', contact.first_name, contact.title, contact.timezone, contact.locale, JSON.stringify(contact.attributes), now, now);
  if (contact.email) addPoint(db, workspaceId, id, 'email', contact.email, profile, contact.country, `import:${batchId}`, now);
  if (contact.profile_url) addPoint(db, workspaceId, id, 'social_profile', contact.profile_url, profile, contact.country, `import:${batchId}`, now);
  if (contact.phone) addPoint(db, workspaceId, id, 'phone', contact.phone, profile, contact.country, `import:${batchId}`, now);
  return id;
}

/** Fills empty fields only; never overwrites what a person or earlier import already set. */
function updateContact(db: SqlDatabase, workspaceId: string, contactId: string, contact: NormalizedContact, profile: MappingProfile, batchId: string, now: number): void {
  const current = db.prepare('SELECT attributes FROM contacts WHERE id = ?').get<{ attributes: string }>(contactId);
  const attributes = { ...contact.attributes, ...(JSON.parse(current?.attributes ?? '{}') as Record<string, string>) };
  db.prepare(
    `UPDATE contacts SET first_name = COALESCE(first_name, ?), title = COALESCE(title, ?), timezone = COALESCE(timezone, ?),
       locale = COALESCE(locale, ?), organization_id = COALESCE(organization_id, ?), attributes = ?, updated_at = ? WHERE id = ?`,
  ).run(contact.first_name, contact.title, contact.timezone, contact.locale, organizationFor(db, workspaceId, contact, now), JSON.stringify(attributes), now, contactId);
  if (contact.email) addPoint(db, workspaceId, contactId, 'email', contact.email, profile, contact.country, `import:${batchId}`, now);
  if (contact.profile_url) addPoint(db, workspaceId, contactId, 'social_profile', contact.profile_url, profile, contact.country, `import:${batchId}`, now);
}
