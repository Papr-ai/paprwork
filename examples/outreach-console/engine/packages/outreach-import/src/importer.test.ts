import { describe, expect, it } from 'vitest';
import { verifyAuditChain, type SqlDatabase } from '@splitin/outreach-contracts';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { ImportRejectedError } from './detect';
import { ImportStaleError, commitImport, previewImport, type ImportActor } from './importer';
import { ProfileError, saveMappingProfile } from './profile';

const NOW = 1_700_000_000_000;
const actor: ImportActor = { workspaceId: 'ws', principalId: 'p1', source: 'test', traceId: 't' };
const enc = (text: string) => new TextEncoder().encode(text);

function setup(profileOverrides: Record<string, unknown> = {}): { db: SqlDatabase; profileId: string } {
  const db = openSqliteDatabase(':memory:');
  db.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('ws', 'W', 0)`).run();
  const profile = db.transaction(() =>
    saveMappingProfile(db, 'ws', 'leads', {
      columns: { email: ['Email', 'E-mail'], full_name: 'Name', title: 'Title', org_name: 'Company', timezone: 'TZ', profile_url: 'Profile' },
      attributes: { segment: 'Segment' },
      consent: { basis: 'legitimate_interest', evidence: 'public business contact' },
      jurisdiction: 'US',
      ...profileOverrides,
    }, NOW),
  );
  return { db, profileId: profile.id };
}

const CSV = [
  'Name,Email,Title,Company,TZ,Segment,Profile',
  'Ada Lovelace,Ada@Example.org,CTO,Analytical,America/New_York,enterprise,https://www.linkedin.com/in/ada/?trk=x',
  'Ada Again,ada@example.org,,,,,',
  'Bad Email,not-an-email,,,,,',
  'No Email,,,,,,',
  'Grace Hopper,grace@example.net,Admiral,Navy,Mars/Base,,',
  '"Quote, Inc","q@example.com",,"=HYPERLINK(""http://evil.example"")",,,',
].join('\n');

async function preview(db: SqlDatabase, profileId: string, text: string | Uint8Array, fileName = 'leads.csv') {
  return previewImport(db, actor, { fileName, bytes: typeof text === 'string' ? enc(text) : text, profileId, now: NOW });
}

describe('preview', () => {
  it('normalizes, validates and resolves duplicates without creating contacts', async () => {
    const { db, profileId } = setup();
    const result = await preview(db, profileId, CSV);
    expect(result.counts).toEqual({ create: 2, update: 0, merge: 1, reject: 3, ambiguous: 0 });
    expect(result.samples.create[0]?.contact).toMatchObject({
      email: 'ada@example.org', first_name: 'Ada', org_domain: 'example.org', profile_url: 'https://linkedin.com/in/ada', attributes: { segment: 'enterprise' },
    });
    expect(result.samples.reject.map((r) => r.note)).toEqual([
      'invalid email "not-an-email"',
      'missing required email',
      'unknown time zone "Mars/Base"',
    ]);
    expect(result.samples.merge[0]).toMatchObject({ ordinal: 1, note: 'same email as an earlier row' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM contacts').get<{ n: number }>()?.n).toBe(0);
  });

  it('keeps formula-looking cells as inert data', async () => {
    const { db, profileId } = setup();
    const result = await preview(db, profileId, CSV);
    const row = result.samples.create.find((r) => r.contact.email === 'q@example.com');
    expect(row?.contact.org_name).toBe('=HYPERLINK("http://evil.example")');
  });

  it('treats __proto__ and constructor headers as plain keys', async () => {
    const { db, profileId } = setup({ columns: { email: 'Email', full_name: '__proto__' }, attributes: { ctor: 'constructor' } });
    const result = await preview(db, profileId, '__proto__,Email,constructor\nPolly,polly@example.org,x\n');
    expect(result.samples.create[0]?.contact).toMatchObject({ full_name: 'Polly', attributes: { ctor: 'x' } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.toString.call({})).toBe('[object Object]');
  });

  it('falls back to Windows-1252 with a warning and honours a UTF-8 BOM', async () => {
    const { db, profileId } = setup();
    const latin = Uint8Array.from([...enc('Name,Email\nJos'), 0xe9, ...enc(',jose@example.org\n')]);
    const result = await preview(db, profileId, latin);
    expect(result.samples.create[0]?.contact.full_name).toBe('José');
    expect(result.warnings[0]).toMatch(/Windows-1252/);
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...enc('Name,Email\nZoë,zoe@example.org\n')]);
    expect((await preview(db, profileId, bom)).samples.create[0]?.contact.full_name).toBe('Zoë');
  });

  it('enforces size and row limits', async () => {
    const { db, profileId } = setup();
    await expect(previewImport(db, actor, { fileName: 'x.csv', bytes: enc(CSV), profileId, now: NOW, limits: { maxRows: 3 } })).rejects.toThrow(ImportRejectedError);
    await expect(previewImport(db, actor, { fileName: 'x.csv', bytes: enc(CSV), profileId, now: NOW, limits: { maxBytes: 10 } })).rejects.toThrow(/larger than/);
  });

  it('rejects invalid mapping profiles with paths', () => {
    const db = openSqliteDatabase(':memory:');
    db.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('ws', 'W', 0)`).run();
    expect(() => saveMappingProfile(db, 'ws', 'bad', { columns: { mail: 'Email' }, consent: { basis: 'maybe' } }, NOW)).toThrow(ProfileError);
  });
});

describe('country column (decision D5)', () => {
  const COUNTRY_CSV = ['Name,Email,Country', 'Ada,ada@example.org,US', 'Hans,hans@example.de,Germany', 'Kim,kim@example.kr,south korea',
    'Nobody,nobody@example.org,', 'Bad,bad@example.org,Atlantis', 'Pseudo,eu@example.org,EU'].join('\n');

  it('maps codes and English names per row, falls back to the profile, and rejects what it cannot resolve', async () => {
    const { db, profileId } = setup({ columns: { email: 'Email', full_name: 'Name', country: 'Country' }, jurisdiction: 'unknown' });
    const result = await preview(db, profileId, COUNTRY_CSV);
    expect(result.samples.reject.map((r) => r.note)).toEqual(['unknown country "Atlantis"', 'unknown country "EU"']);
    commitImport(db, actor, { batchId: result.batchId, previewHash: result.previewHash, idempotencyKey: 'c1', now: NOW });
    const rows = db.prepare(`SELECT value_norm, jurisdiction FROM contact_points ORDER BY value_norm`).all();
    expect(rows).toEqual([
      { value_norm: 'ada@example.org', jurisdiction: 'US' },
      { value_norm: 'hans@example.de', jurisdiction: 'DE' },
      { value_norm: 'kim@example.kr', jurisdiction: 'KR' },
      { value_norm: 'nobody@example.org', jurisdiction: 'unknown' },
    ]);
  });

  it('fills in an unknown country on re-import but never overwrites a known one', async () => {
    const { db, profileId } = setup({ columns: { email: 'Email', full_name: 'Name', country: 'Country' }, jurisdiction: 'unknown' });
    const first = await preview(db, profileId, 'Name,Email,Country\nAda,ada@example.org,\nHans,hans@example.de,DE');
    commitImport(db, actor, { batchId: first.batchId, previewHash: first.previewHash, idempotencyKey: 'c1', now: NOW });
    const second = await preview(db, profileId, 'Name,Email,Country\nAda,ada@example.org,GB\nHans,hans@example.de,AT');
    commitImport(db, actor, { batchId: second.batchId, previewHash: second.previewHash, idempotencyKey: 'c2', now: NOW });
    expect(db.prepare(`SELECT value_norm, jurisdiction FROM contact_points ORDER BY value_norm`).all()).toEqual([
      { value_norm: 'ada@example.org', jurisdiction: 'GB' },
      { value_norm: 'hans@example.de', jurisdiction: 'DE' },
    ]);
  });
});

describe('commit', () => {
  it('creates contacts with provenance and consent, merges duplicates, and is idempotent', async () => {
    const { db, profileId } = setup();
    const result = await preview(db, profileId, CSV);
    const first = commitImport(db, actor, { batchId: result.batchId, previewHash: result.previewHash, idempotencyKey: 'k1', now: NOW });
    expect(first).toMatchObject({ created: 2, merged: 1, skipped: 3, alreadyCommitted: false });
    const point = db.prepare(`SELECT source, consent_basis, jurisdiction FROM contact_points WHERE value_norm = 'ada@example.org'`).get();
    expect(point).toEqual({ source: `import:${result.batchId}`, consent_basis: 'legitimate_interest', jurisdiction: 'US' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM contact_points WHERE kind = 'social_profile'`).get<{ n: number }>()?.n).toBe(1);
    const linked = db.prepare(`SELECT COUNT(DISTINCT contact_id) AS n FROM import_rows WHERE batch_id = ? AND contact_id IS NOT NULL`).get<{ n: number }>(result.batchId);
    expect(linked?.n).toBe(2);
    expect(commitImport(db, actor, { batchId: result.batchId, previewHash: result.previewHash, idempotencyKey: 'k1', now: NOW }).alreadyCommitted).toBe(true);
    expect(() => commitImport(db, actor, { batchId: result.batchId, previewHash: result.previewHash, idempotencyKey: 'k2', now: NOW })).toThrow(ImportStaleError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM enrollments').get<{ n: number }>()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM scheduled_actions').get<{ n: number }>()?.n).toBe(0);
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it('updates existing contacts without overwriting and flags ambiguous look-alikes', async () => {
    const { db, profileId } = setup();
    const seed = await preview(db, profileId, 'Name,Email,Title,Company\nAda Lovelace,ada@example.org,CTO,Analytical\n');
    commitImport(db, actor, { batchId: seed.batchId, previewHash: seed.previewHash, idempotencyKey: 'seed', now: NOW });
    const second = await preview(db, profileId, 'Name,Email,Title,TZ\nAda L,ada@example.org,Intern,Europe/London\nAda Lovelace,ada.l@example.org,,\n');
    expect(second.counts).toMatchObject({ update: 1, ambiguous: 1 });
    commitImport(db, actor, { batchId: second.batchId, previewHash: second.previewHash, idempotencyKey: 'k', now: NOW });
    expect(db.prepare('SELECT title, timezone FROM contacts').all()).toEqual([{ title: 'CTO', timezone: 'Europe/London' }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM contact_points WHERE value_norm = 'ada.l@example.org'`).get<{ n: number }>()?.n).toBe(0);
  });

  it('refuses a stale preview when the workspace changed in between', async () => {
    const { db, profileId } = setup();
    const a = await preview(db, profileId, 'Name,Email\nAda,ada@example.org\n');
    const b = await preview(db, profileId, 'Name,Email\nAda,ada@example.org\n');
    commitImport(db, actor, { batchId: a.batchId, previewHash: a.previewHash, idempotencyKey: 'a', now: NOW });
    expect(() => commitImport(db, actor, { batchId: b.batchId, previewHash: b.previewHash, idempotencyKey: 'b', now: NOW })).toThrow(/workspace changed/);
    expect(() => commitImport(db, actor, { batchId: b.batchId, previewHash: 'forged', idempotencyKey: 'b', now: NOW })).toThrow(ImportStaleError);
  });
});

describe('performance', () => {
  it('previews 100k rows within the budget', async () => {
    const { db, profileId } = setup();
    const lines = ['Name,Email,Company,Segment'];
    for (let i = 0; i < 100_000; i += 1) lines.push(`Person ${i},person${i}@example${i % 500}.org,Company ${i % 500},s${i % 7}`);
    const started = performance.now();
    const result = await preview(db, profileId, lines.join('\n'));
    const elapsed = performance.now() - started;
    expect(result.counts.create).toBe(100_000);
    expect(elapsed).toBeLessThan(10_000);
  }, 60_000);
});
