import { ulid, type SqlDatabase } from '@splitin/outreach-contracts';
import { z } from 'zod';

export const CANONICAL_FIELDS = [
  'email',
  'full_name',
  'first_name',
  'last_name',
  'title',
  'org_name',
  'org_domain',
  'profile_url',
  'timezone',
  'locale',
  'phone',
  /** ISO 3166 code or English country name; overrides the profile-wide `jurisdiction` for that row. */
  'country',
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

const columnRef = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const htmlSpec = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('table'), table: z.number().int().min(0).default(0) }).strict(),
  z
    .object({
      mode: z.literal('cards'),
      /** Simple selector for one record, e.g. "div.person" or "li[data-lead]". */
      card: z.string().min(1),
      /** Column name -> selector within the card; "selector@attr" reads an attribute, "@attr" reads the card's own. */
      fields: z.record(z.string(), z.string().min(1)),
    })
    .strict(),
]);

export const MappingProfileSchema = z
  .object({
    format: z.enum(['csv', 'xlsx', 'html', 'json']).optional(),
    delimiter: z.string().length(1).optional(),
    sheet: z.string().optional(),
    html: htmlSpec.optional(),
    /** Canonical field -> source column name(s); the first non-empty match wins. Matching is case-insensitive. */
    columns: z.partialRecord(z.enum(CANONICAL_FIELDS), columnRef),
    /** Extra attributes kept on the contact, available to templates as {{attr.<key>}}. */
    attributes: z.record(z.string().regex(/^[a-z0-9_]+$/), columnRef).default({}),
    required: z.array(z.enum(CANONICAL_FIELDS)).default(['email']),
    consent: z
      .object({
        basis: z.enum(['consent', 'legitimate_interest', 'existing_relationship', 'unknown']),
        evidence: z.string().max(500).optional(),
      })
      .strict(),
    jurisdiction: z.string().regex(/^([A-Z]{2}|unknown)$/).default('unknown'),
    /** Derive first/last name from full_name when absent (first token / rest). */
    splitFullName: z.boolean().default(true),
  })
  .strict();

export type MappingProfile = z.infer<typeof MappingProfileSchema>;

export interface StoredProfile {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly spec: MappingProfile;
}

export class ProfileError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid mapping profile:\n- ${issues.join('\n- ')}`);
    this.name = 'ProfileError';
  }
}

export function parseProfile(input: unknown): MappingProfile {
  const result = MappingProfileSchema.safeParse(input);
  if (!result.success) throw new ProfileError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  return result.data;
}

/** Stores a new immutable version of a named profile. Must run inside a transaction. */
export function saveMappingProfile(db: SqlDatabase, workspaceId: string, name: string, input: unknown, now: number): StoredProfile {
  const spec = parseProfile(input);
  const latest = db.prepare('SELECT MAX(version) AS v FROM mapping_profiles WHERE workspace_id = ? AND name = ?').get<{ v: number | null }>(workspaceId, name);
  const version = (latest?.v ?? 0) + 1;
  const id = ulid(now);
  db.prepare('INSERT INTO mapping_profiles (id, workspace_id, name, version, spec) VALUES (?,?,?,?,?)').run(id, workspaceId, name, version, JSON.stringify(spec));
  return { id, name, version, spec };
}

export function loadMappingProfile(db: SqlDatabase, workspaceId: string, id: string): StoredProfile | undefined {
  const row = db.prepare('SELECT id, name, version, spec FROM mapping_profiles WHERE workspace_id = ? AND id = ?')
    .get<{ id: string; name: string; version: number; spec: string }>(workspaceId, id);
  return row ? { id: row.id, name: row.name, version: row.version, spec: JSON.parse(row.spec) as MappingProfile } : undefined;
}
