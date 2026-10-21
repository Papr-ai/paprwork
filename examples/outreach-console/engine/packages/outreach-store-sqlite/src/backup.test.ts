import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  renameSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'vitest';
import type { SqlDatabase } from '@splitin/outreach-contracts';
import { BackupError, runDueBackup, type BackupConfiguration, type BackupOutcome } from './backup';
import { openSqliteDatabase } from './open';
import { wrapNativeDatabase, type NativeDatabase } from './driver';

const open: SqlDatabase[] = [];
const directories: string[] = [];
const DAY = 86_400_000;

function fixture(name = 'source.sqlite'): { db: SqlDatabase; config: BackupConfiguration; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'outreach-backup-'));
  directories.push(directory);
  const sourceDatabasePath = join(directory, name);
  const db = openSqliteDatabase(sourceDatabasePath, { migrate: false });
  open.push(db);
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT');
  db.prepare('INSERT INTO items VALUES (?, ?)').run(1, 'synthetic');
  return { db, directory, config: { sourceDatabasePath, directory: join(directory, 'backups'), intervalMs: DAY } };
}

function snapshot(result: BackupOutcome) {
  assert.ok(result.status === 'created' || result.status === 'not_due');
  return result;
}

function snapshotFiles(path: string): string[] {
  return readdirSync(path).filter((name) => /^\d+-.*\.sqlite$/.test(name));
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('opt-in SQLite backups', () => {
  it('does nothing without explicit configuration', () => {
    const { db, config } = fixture();
    assert.deepEqual(runDueBackup(db), { status: 'disabled' });
    assert.equal(existsSync(config.directory), false);
  });

  it('requires an explicit positive safe cadence and a safe timestamp', () => {
    const { db, config } = fixture();
    for (const intervalMs of [0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => runDueBackup(db, { ...config, intervalMs }, 100), BackupError);
    }
    for (const now of [-1, 0.5, Infinity, NaN]) assert.throws(() => runDueBackup(db, config, now), BackupError);
    assert.equal(existsSync(config.directory), false);
  });

  it('refuses a mismatched source or memory database before creating a destination', () => {
    const { db, config } = fixture();
    const other = fixture();
    assert.throws(() => runDueBackup(db, { ...config, sourceDatabasePath: other.config.sourceDatabasePath }), /does not match/);
    const memory = openSqliteDatabase(':memory:', { migrate: false });
    open.push(memory);
    assert.throws(() => runDueBackup(memory, config), /on-disk/);
    assert.equal(existsSync(config.directory), false);
  });

  it('consistently captures committed WAL data, verifies integrity, and creates private output', () => {
    const { db, config } = fixture("source's database.sqlite");
    for (let id = 2; id <= 50; id += 1) db.prepare('INSERT INTO items VALUES (?, ?)').run(id, `synthetic-${id}`);
    assert.ok(lstatSync(`${config.sourceDatabasePath}-wal`).size > 0);
    const result = snapshot(runDueBackup(db, { ...config, directory: join(dirname(config.directory), "backup's directory") }, 100));
    assert.equal(result.status, 'created');
    assert.equal(result.nextDueAt, 100 + DAY);
    const saved = new DatabaseSync(result.path, { readOnly: true });
    try {
      assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM items').get()?.n, 50);
      assert.equal(saved.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    } finally { saved.close(); }
    assert.equal(lstatSync(result.path).mode & 0o777, 0o600);
    assert.equal(lstatSync(dirname(result.path)).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(dirname(result.path), 'backup-state.sqlite')).mode & 0o777, 0o600);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get<{ n: number }>()?.n, 50);
  });

  it('persists cadence across connections and never overwrites prior snapshots', () => {
    const { db, config } = fixture();
    const first = snapshot(runDueBackup(db, config, 100));
    const original = readFileSync(first.path);
    const reopened = openSqliteDatabase(config.sourceDatabasePath, { migrate: false });
    open.push(reopened);
    const skipped = snapshot(runDueBackup(reopened, config, 100 + DAY - 1));
    assert.equal(skipped.status, 'not_due');
    assert.equal(skipped.path, first.path);
    reopened.prepare('INSERT INTO items VALUES (?, ?)').run(2, 'later');
    const second = snapshot(runDueBackup(reopened, config, 100 + DAY));
    assert.equal(second.status, 'created');
    assert.notEqual(first.path, second.path);
    assert.deepEqual(readFileSync(first.path), original);
    assert.equal(snapshotFiles(dirname(first.path)).length, 2);
  });

  it('keeps independent source databases separate in the same destination', () => {
    const first = fixture();
    const second = fixture();
    const a = snapshot(runDueBackup(first.db, first.config, 100));
    const b = snapshot(runDueBackup(second.db, { ...second.config, directory: first.config.directory }, 100));
    assert.equal(b.status, 'created');
    assert.notEqual(dirname(a.path), dirname(b.path));
  });

  it('canonicalizes source aliases without giving them a separate cadence', () => {
    const { db, config, directory } = fixture();
    const first = snapshot(runDueBackup(db, config, 100));
    const alias = join(directory, 'source-alias.sqlite');
    symlinkSync(config.sourceDatabasePath, alias);
    const result = snapshot(runDueBackup(db, { ...config, sourceDatabasePath: alias }, 101));
    assert.equal(result.status, 'not_due');
    assert.equal(result.path, first.path);
  });

  it('rejects an old open handle after its source path is replaced, even before its first backup', () => {
    const { db: old, config, directory } = fixture();
    old.exec('PRAGMA journal_mode = DELETE');
    renameSync(config.sourceDatabasePath, join(directory, 'old.sqlite'));
    const replacement = openSqliteDatabase(config.sourceDatabasePath, { migrate: false });
    open.push(replacement);
    replacement.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO items VALUES (1, 'replacement')");
    assert.throws(() => runDueBackup(old, config, 100), /replaced after/);
    assert.equal(existsSync(config.directory), false);
    const result = snapshot(runDueBackup(replacement, config, 101));
    assert.equal(result.status, 'created');
    const saved = new DatabaseSync(result.path, { readOnly: true });
    try { assert.equal(saved.prepare('SELECT value FROM items').get()?.value, 'replacement'); }
    finally { saved.close(); }
  });

  it('does not let a replacement database inherit an earlier source inode’s cadence', () => {
    const { db: old, config, directory } = fixture();
    const first = snapshot(runDueBackup(old, config, 100));
    old.exec('PRAGMA journal_mode = DELETE');
    renameSync(config.sourceDatabasePath, join(directory, 'old.sqlite'));
    const replacement = openSqliteDatabase(config.sourceDatabasePath, { migrate: false });
    open.push(replacement);
    replacement.exec('CREATE TABLE replacement (id INTEGER PRIMARY KEY) STRICT');
    const second = snapshot(runDueBackup(replacement, config, 101));
    assert.equal(second.status, 'created');
    assert.notEqual(first.path, second.path);
    assert.ok(existsSync(first.path));
    assert.throws(() => runDueBackup(old, config, 102), /replaced after/);
  });

  it('refuses arbitrary or adapted handles with no verified open-time provenance', () => {
    const { config } = fixture();
    const adapted = wrapNativeDatabase(new DatabaseSync(config.sourceDatabasePath) as unknown as NativeDatabase);
    open.push(adapted);
    assert.throws(() => runDueBackup(adapted, config, 100), /identity is unverified/);
    assert.equal(existsSync(config.directory), false);
  });

  it('rejects relative, symlinked, and publicly writable backup destinations', () => {
    const { db, config, directory } = fixture();
    assert.throws(() => runDueBackup(db, { ...config, directory: 'backups' }), /absolute/);
    const real = join(directory, 'real');
    mkdirSync(real, { mode: 0o700 });
    const alias = join(directory, 'alias');
    symlinkSync(real, alias);
    assert.throws(() => runDueBackup(db, { ...config, directory: join(alias, 'child') }), /symlink/);
    assert.equal(existsSync(join(real, 'child')), false);
    chmodSync(real, 0o777);
    assert.throws(() => runDueBackup(db, { ...config, directory: real }), /writable/);
    chmodSync(real, 0o700);
  });

  it('rejects a symlinked coordination file without touching its target', () => {
    const { db, config, directory } = fixture();
    const result = snapshot(runDueBackup(db, config, 100));
    const state = join(dirname(result.path), 'backup-state.sqlite');
    const target = join(directory, 'unrelated');
    writeFileSync(target, 'not a database', { mode: 0o600 });
    rmSync(state);
    symlinkSync(target, state);
    assert.throws(() => runDueBackup(db, config, 101), /regular file/);
    assert.equal(readFileSync(target, 'utf8'), 'not a database');
  });

  it('does not trust a success record when its snapshot is missing or truncated', () => {
    const { db, config } = fixture();
    const first = snapshot(runDueBackup(db, config, 100));
    writeFileSync(first.path, '');
    const second = snapshot(runDueBackup(db, config, 101));
    assert.equal(second.status, 'created');
    assert.equal(second.previousInvalidBackup, first.path);
    assert.equal(lstatSync(first.path).size, 0);
    rmSync(second.path);
    const third = snapshot(runDueBackup(db, config, 102));
    assert.equal(third.status, 'created');
    assert.equal(third.previousInvalidBackup, second.path);
  });

  it('fails closed for a symlinked snapshot rather than following or replacing it', () => {
    const { db, config, directory } = fixture();
    const first = snapshot(runDueBackup(db, config, 100));
    const target = join(directory, 'unrelated');
    writeFileSync(target, 'keep', { mode: 0o600 });
    rmSync(first.path);
    symlinkSync(target, first.path);
    assert.throws(() => runDueBackup(db, config, 101), /regular file/);
    assert.equal(readFileSync(target, 'utf8'), 'keep');
    assert.equal(snapshotFiles(dirname(first.path)).length, 1);
  });

  it('preserves interrupted output and retries without committing cadence on failure', () => {
    const { db, config } = fixture();
    let attemptedPath: string | undefined;
    const prepare = db.prepare;
    db.prepare = (sql) => {
      if (sql.startsWith('VACUUM')) throw new Error('synthetic interruption');
      return prepare(sql);
    };
    assert.throws(() => runDueBackup(db, config, 100), (error: unknown) => {
      assert.ok(error instanceof BackupError);
      attemptedPath = error.backupPath;
      assert.ok(attemptedPath);
      assert.equal(lstatSync(attemptedPath).size, 0);
      return true;
    });
    db.prepare = prepare;
    const recovered = snapshot(runDueBackup(db, config, 101));
    assert.equal(recovered.status, 'created');
    assert.notEqual(recovered.path, attemptedPath);
    assert.ok(attemptedPath && existsSync(attemptedPath));
    assert.equal(snapshotFiles(dirname(recovered.path)).length, 2);
  });

  it('rejects snapshots containing foreign-key violations and preserves their outputs', () => {
    const { db, config } = fixture();
    db.exec(`PRAGMA foreign_keys = OFF;
      CREATE TABLE children (parent_id INTEGER REFERENCES items(id)) STRICT;
      INSERT INTO children VALUES (999)`);
    assert.throws(() => runDueBackup(db, config, 100), (error: unknown) => {
      assert.ok(error instanceof BackupError);
      assert.match(error.message, /foreign_key_check/);
      assert.ok(error.backupPath && existsSync(error.backupPath));
      return true;
    });
    db.exec('DELETE FROM children; PRAGMA foreign_keys = ON');
    assert.equal(runDueBackup(db, config, 101).status, 'created');
  });

  it('claims atomically and prevents a concurrent backup from creating another snapshot', () => {
    const { db, config } = fixture();
    let nested: BackupOutcome | undefined;
    const prepare = db.prepare;
    db.prepare = (sql) => {
      if (sql.startsWith('VACUUM')) nested = runDueBackup(db, config, 100);
      return prepare(sql);
    };
    const result = snapshot(runDueBackup(db, config, 100));
    db.prepare = prepare;
    assert.deepEqual(nested, { status: 'busy' });
    assert.equal(snapshotFiles(dirname(result.path)).length, 1);
    assert.equal(runDueBackup(db, config, 101).status, 'not_due');
  });

  it('recovers a process-crashed claim, ignores uncommitted success, and preserves partial output', () => {
    const { db, config } = fixture();
    const first = snapshot(runDueBackup(db, config, 100));
    const namespace = dirname(first.path);
    const partial = join(namespace, 'interrupted-output.sqlite');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      import { writeFileSync } from 'node:fs';
      const state = new DatabaseSync(process.argv[1]);
      state.exec('BEGIN IMMEDIATE');
      state.prepare('UPDATE backup_state SET completed_at = ?').run(${100 + DAY});
      writeFileSync(process.argv[2], 'partial snapshot', { mode: 0o600 });
      process.kill(process.pid, 'SIGKILL');
    `, join(namespace, 'backup-state.sqlite'), partial], { timeout: 10_000, encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const recovered = snapshot(runDueBackup(db, config, 100 + DAY));
    assert.equal(recovered.status, 'created');
    assert.equal(readFileSync(partial, 'utf8'), 'partial snapshot');
    assert.ok(existsSync(first.path));
    assert.equal(runDueBackup(db, config, 100 + DAY + 1).status, 'not_due');
  });
});
