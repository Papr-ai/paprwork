import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendAudit, verifyAuditChain, type SqlDatabase } from '@splitin/outreach-contracts';
import { MIGRATIONS, MigrationDriftError, TransactionMisuseError, migrate, openSqliteDatabase } from './index';

const open: SqlDatabase[] = [];
const dirs: string[] = [];
function memory(): SqlDatabase {
  const db = openSqliteDatabase(':memory:');
  open.push(db);
  return db;
}
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(db: SqlDatabase): void {
  db.exec(`
    INSERT INTO workspaces (id, name, created_at) VALUES ('ws', 'Workspace', 0);
    INSERT INTO contacts (id, workspace_id, full_name, created_at, updated_at) VALUES ('c1', 'ws', 'Ada', 0, 0);
    INSERT INTO contact_points (id, workspace_id, contact_id, kind, value_norm, value_raw, source)
      VALUES ('cp1', 'ws', 'c1', 'email', 'ada@example.org', 'Ada@Example.org', 'manual');
    INSERT INTO provider_accounts (id, workspace_id, provider, external_account_id, sender_identity, purposes, secret_ref)
      VALUES ('pa', 'ws', 'fake', 'ext', '{}', '[]', 'env:X');
    INSERT INTO sequence_versions (id, workspace_id, name, version, spec, spec_hash, created_at)
      VALUES ('sv', 'ws', 'seq', 1, '{}', 'h', 0);
    INSERT INTO campaigns (id, workspace_id, name, purpose, status, created_at, updated_at)
      VALUES ('camp', 'ws', 'C', 'automated_outreach', 'active', 0, 0);
    INSERT INTO campaign_versions (id, campaign_id, version, sequence_version_id, provider_account_id, policy, policy_hash, audience)
      VALUES ('cv', 'camp', 1, 'sv', 'pa', '{}', 'p', '{}');
  `);
}

function enroll(db: SqlDatabase, id: string, status: string): void {
  db.prepare(
    `INSERT INTO enrollments (id, workspace_id, campaign_id, campaign_version_id, contact_id, contact_point_id,
       status, enrolled_at, updated_at) VALUES (?, 'ws', 'camp', 'cv', 'c1', 'cp1', ?, 0, 0)`,
  ).run(id, status);
}

describe('migrations', () => {
  it('apply once and are idempotent', () => {
    const db = memory();
    expect(migrate(db)).toEqual([]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['scheduled_actions', 'audit_events', 'enrollments']));
  });

  it('refuse an edited migration', () => {
    const db = memory();
    const edited = MIGRATIONS.map((m) => ({ ...m, sql: `${m.sql}\n-- edited` }));
    expect(() => migrate(db, edited)).toThrow(MigrationDriftError);
  });
});

describe('constraints', () => {
  it('allow one live enrollment per contact and campaign, but many finished ones', () => {
    const db = memory();
    seed(db);
    enroll(db, 'e1', 'completed');
    enroll(db, 'e2', 'active');
    expect(() => enroll(db, 'e3', 'paused')).toThrow(/UNIQUE/);
    enroll(db, 'e4', 'replied');
  });

  it('dedupe actions by idempotency key and provider events by provider id', () => {
    const db = memory();
    seed(db);
    const action = db.prepare(
      `INSERT INTO scheduled_actions (id, workspace_id, kind, state, due_at, payload, content_hash, idempotency_key,
         created_at, updated_at) VALUES (?, 'ws', 'email.send', 'scheduled', 0, '{}', 'h', 'key-1', 0, 0)`,
    );
    action.run('a1');
    expect(() => action.run('a2')).toThrow(/UNIQUE/);
    const event = db.prepare(
      `INSERT INTO provider_events (id, workspace_id, provider_account_id, provider_event_id, kind, payload,
         payload_digest, status, received_at) VALUES (?, 'ws', 'pa', 'evt-1', 'message', '{}', 'd', 'pending', 0)`,
    );
    event.run('pe1');
    expect(() => event.run('pe2')).toThrow(/UNIQUE/);
  });

  it('reject unknown states and wrong types (STRICT)', () => {
    const db = memory();
    seed(db);
    expect(() =>
      db.exec(`INSERT INTO scheduled_actions (id, workspace_id, kind, state, due_at, payload, content_hash,
        idempotency_key, created_at, updated_at) VALUES ('x', 'ws', 'email.send', 'sending', 0, '{}', 'h', 'k', 0, 0)`),
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(`INSERT INTO scheduled_actions (id, workspace_id, kind, state, due_at, payload, content_hash,
        idempotency_key, created_at, updated_at) VALUES ('y', 'ws', 'email.send', 'scheduled', 'soon', '{}', 'h', 'k2', 0, 0)`),
    ).toThrow();
  });

  it('enforce foreign keys', () => {
    const db = memory();
    expect(() =>
      db.exec(`INSERT INTO contacts (id, workspace_id, full_name, created_at, updated_at) VALUES ('c', 'missing', 'x', 0, 0)`),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('audit chain', () => {
  const entry = (i: number) => ({
    workspaceId: 'ws',
    at: i,
    actorKind: 'system' as const,
    actorId: 'test',
    source: 'test',
    traceId: `t${i}`,
    resourceKind: 'thing',
    resourceId: `r${i}`,
    action: 'touched',
    detail: { i },
  });

  it('is append-only and verifiable', () => {
    const db = memory();
    db.transaction(() => {
      for (let i = 0; i < 5; i += 1) appendAudit(db, entry(i));
    });
    expect(verifyAuditChain(db)).toEqual({ ok: true, count: 5 });
    expect(() => db.exec("UPDATE audit_events SET action = 'x' WHERE seq = 2")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM audit_events WHERE seq = 2')).toThrow(/append-only/);
  });

  it('detects tampering even if the triggers are bypassed', () => {
    const db = memory();
    db.transaction(() => {
      for (let i = 0; i < 3; i += 1) appendAudit(db, entry(i));
    });
    db.exec('DROP TRIGGER audit_no_update');
    db.exec("UPDATE audit_events SET detail = '{\"i\":42}' WHERE seq = 2");
    expect(verifyAuditChain(db)).toEqual({ ok: false, count: 3, brokenAtSeq: 2 });
  });
});

describe('transactions', () => {
  it('roll back on error, including nested savepoints', () => {
    const db = memory();
    db.exec(`INSERT INTO workspaces (id, name, created_at) VALUES ('ws', 'W', 0)`);
    expect(() =>
      db.transaction(() => {
        db.exec(`UPDATE workspaces SET name = 'outer' WHERE id = 'ws'`);
        db.transaction(() => db.exec(`UPDATE workspaces SET name = 'inner' WHERE id = 'ws'`));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare(`SELECT name FROM workspaces`).get<{ name: string }>()?.name).toBe('W');

    db.transaction(() => {
      db.exec(`UPDATE workspaces SET name = 'kept' WHERE id = 'ws'`);
      expect(() =>
        db.transaction(() => {
          db.exec(`UPDATE workspaces SET name = 'dropped' WHERE id = 'ws'`);
          throw new Error('inner');
        }),
      ).toThrow('inner');
    });
    expect(db.prepare(`SELECT name FROM workspaces`).get<{ name: string }>()?.name).toBe('kept');
  });

  it('refuse async callbacks', () => {
    const db = memory();
    expect(() => db.transaction(() => Promise.resolve(1))).toThrow(TransactionMisuseError);
  });

  it('serialize writers across connections to one file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outreach-store-'));
    dirs.push(dir);
    const path = join(dir, 'outreach.db');
    const a = openSqliteDatabase(path);
    const b = openSqliteDatabase(path, { busyTimeoutMs: 0 });
    open.push(a, b);
    a.exec(`INSERT INTO workspaces (id, name, created_at) VALUES ('ws', 'W', 0)`);
    expect(() =>
      a.transaction(() => {
        a.exec(`UPDATE workspaces SET name = 'a' WHERE id = 'ws'`);
        b.transaction(() => b.exec(`UPDATE workspaces SET name = 'b' WHERE id = 'ws'`));
      }),
    ).toThrow(/locked|busy/i);
    expect(b.prepare(`SELECT name FROM workspaces`).get<{ name: string }>()?.name).toBe('W');
  });
});
