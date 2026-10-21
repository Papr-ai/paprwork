import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase } from '@splitin/outreach-contracts';

export interface BackupConfiguration {
  /** Explicit local destination. Symlink components and publicly writable destinations are rejected. */
  readonly directory: string;
  /** Explicit positive cadence, e.g. 86_400_000 for daily. No retention/deletion policy is implied. */
  readonly intervalMs: number;
  /** Must identify the connected database's on-disk main database. In-memory databases are rejected. */
  readonly sourceDatabasePath: string;
}

export type BackupOutcome =
  | { readonly status: 'disabled' | 'busy' }
  | {
    readonly status: 'created' | 'not_due';
    readonly path: string;
    readonly completedAt: number;
    readonly nextDueAt: number;
    /** An earlier recorded snapshot was missing/corrupt. It was not overwritten or removed. */
    readonly previousInvalidBackup?: string;
  };

export class BackupError extends Error {
  constructor(message: string, readonly backupPath?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BackupError';
  }
}

class UnsafeBackupPathError extends BackupError {}

interface LastBackup {
  source_identity: string;
  backup_name: string;
  completed_at: number;
}

interface SourceIdentity { path: string; identity: string }

const openedSources = new WeakMap<SqlDatabase, SourceIdentity>();
const STATE_FILE = 'backup-state.sqlite';
const SNAPSHOT_NAME = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function syncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function assertOwnedPrivate(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new UnsafeBackupPathError(`Backup path is not a regular ${directory ? 'directory' : 'file'}: ${path}`);
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new UnsafeBackupPathError(`Backup path must be owned by the current user: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0 || (!directory && stat.nlink !== 1)) {
    throw new UnsafeBackupPathError(`Backup path must be private and must not be hard-linked: ${path}`);
  }
}

/** Check each component before creation, rather than letting recursive mkdir traverse a symlink. */
function destinationDirectory(input: string): string {
  if (!input.trim() || !isAbsolute(input)) throw new BackupError('Backup directory must be an explicit absolute path');
  const path = resolve(input);
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new UnsafeBackupPathError(`Backup directory must not traverse symlinks or non-directories: ${current}`);
      }
      if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
        throw new UnsafeBackupPathError(`Backup directory must not traverse publicly writable non-sticky directories: ${current}`);
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (createError) { if (errorCode(createError) !== 'EEXIST') throw createError; }
      const created = lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new UnsafeBackupPathError(`Unsafe backup directory: ${current}`);
      }
      syncPath(dirname(current));
    }
  }
  const stat = lstatSync(path);
  if ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new UnsafeBackupPathError('Backup destination must be owned by the current user and not writable by others');
  }
  return path;
}

function createPrivateFile(path: string): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  syncPath(dirname(path));
}

function namespaceDirectory(directory: string, sourcePath: string): string {
  const name = createHash('sha256').update(sourcePath).digest('hex');
  const namespace = join(destinationDirectory(directory), `source-${name}`);
  try { mkdirSync(namespace, { mode: 0o700 }); syncPath(dirname(namespace)); }
  catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
  assertOwnedPrivate(namespace, true);
  return namespace;
}

function inspectSource(input: string): SourceIdentity {
  const path = realpathSync(input);
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile()) throw new BackupError('Backup source must be a regular database file');
  return { path, identity: `${path}\n${stat.dev}:${stat.ino}` };
}

/**
 * Internal openSqliteDatabase hook, deliberately not exported by the package entry point.
 * Capture provenance at connection creation, never on a handle's first backup attempt.
 * SQLite's JS API cannot open an existing fd: callers must not rename/replace database paths
 * while opening or backing up. The before/after checks detect ordinary replacement; they do
 * not promise protection against a malicious same-user actor racing and restoring paths.
 */
export function openWithBackupIdentity(path: string, open: (canonicalPath: string) => SqlDatabase): SqlDatabase {
  if (!path || path === ':memory:') return open(path);
  // Establish a new file before capturing its inode. Never truncate an existing database.
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    closeSync(fd);
  } catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
  const before = inspectSource(path);
  const db = open(before.path);
  try {
    if (inspectSource(path).identity !== before.identity) {
      throw new BackupError('Database source changed while its connection was opening');
    }
    openedSources.set(db, before);
    return db;
  } catch (error) { db.close(); throw error; }
}

function sourceIdentity(db: SqlDatabase, configuredPath: string): SourceIdentity {
  const main = db.prepare('PRAGMA database_list').all<{ name: string; file: string }>().find((row) => row.name === 'main');
  if (!configuredPath.trim() || !main?.file) throw new BackupError('Backups require an explicit on-disk main database');
  const captured = openedSources.get(db);
  if (!captured) throw new BackupError('Backup source identity is unverified; use a handle opened by openSqliteDatabase');
  const current = inspectSource(configuredPath);
  if (current.path !== captured.path || current.path !== realpathSync(main.file)) {
    throw new BackupError('Backup sourceDatabasePath does not match the connected database');
  }
  if (current.identity !== captured.identity) {
    throw new BackupError('Database source was replaced after its connection opened; reopen it before backing up');
  }
  return captured;
}

function verifySnapshot(path: string): void {
  assertOwnedPrivate(path, false);
  if (lstatSync(path).size < 100) throw new BackupError(`Snapshot has no complete SQLite header: ${path}`, path);
  const snapshot = new DatabaseSync(path, { readOnly: true });
  try {
    snapshot.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF');
    const rows = snapshot.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== 'ok') {
      throw new BackupError(`Snapshot failed SQLite integrity_check: ${path}`, path);
    }
    if (snapshot.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new BackupError(`Snapshot failed SQLite foreign_key_check: ${path}`, path);
    }
  } finally { snapshot.close(); }
}

function verifiedPrevious(namespace: string, previous: LastBackup): { path: string; valid: boolean } {
  if (!SNAPSHOT_NAME.test(previous.backup_name) || !Number.isSafeInteger(previous.completed_at) || previous.completed_at < 0) {
    throw new BackupError('Invalid backup coordination record; refusing to trust it');
  }
  const path = join(namespace, previous.backup_name);
  try { verifySnapshot(path); return { path, valid: true }; }
  catch (error) {
    // Corruption or a missing snapshot invalidates cadence. Security/access failures are not bypassed.
    if (error instanceof UnsafeBackupPathError || ['EACCES', 'EPERM'].includes(errorCode(error) ?? '')) throw error;
    return { path, valid: false };
  }
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: number } | null)?.errcode;
  return code === 5 || code === 6 || errorCode(error) === 'SQLITE_BUSY' || errorCode(error) === 'SQLITE_LOCKED';
}

/**
 * Opt-in local backup. Call periodically; this does not install a scheduler or delete any backups.
 * VACUUM INTO snapshots committed WAL contents consistently, without copying live database files.
 * A separate SQLite BEGIN IMMEDIATE claim spans cadence checks, snapshot verification and commit.
 * SQLite releases the claim after a crash. An interrupted attempt never commits cadence; its output
 * stays intact for inspection, and the next call creates a new file instead of trusting a marker.
 * Use a local filesystem with SQLite locking/fsync support, not NFS or a cloud-sync directory.
 * Only handles created by openSqliteDatabase carry verifiable open-time provenance. Adapted
 * handles are rejected. Do not move/replace a database path during opening or backup.
 */
export function runDueBackup(
  db: SqlDatabase,
  configuration?: BackupConfiguration,
  now = Date.now(),
): BackupOutcome {
  if (!configuration) return { status: 'disabled' };
  const { intervalMs } = configuration;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(now + intervalMs)) {
    throw new BackupError('Backup intervalMs must be a positive safe integer and now a nonnegative safe timestamp');
  }
  const source = sourceIdentity(db, configuration.sourceDatabasePath);
  const namespace = namespaceDirectory(configuration.directory, source.path);
  const statePath = join(namespace, STATE_FILE);
  try { createPrivateFile(statePath); }
  catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
  assertOwnedPrivate(statePath, false);
  const state = new DatabaseSync(statePath);
  let claimed = false;
  let backupPath: string | undefined;
  try {
    state.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL');
    try { state.exec('BEGIN IMMEDIATE'); claimed = true; }
    catch (error) { if (isBusy(error)) return { status: 'busy' }; throw error; }
    state.exec(`CREATE TABLE IF NOT EXISTS backup_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      source_identity TEXT NOT NULL, backup_name TEXT NOT NULL, completed_at INTEGER NOT NULL
    ) STRICT`);
    const previous = state.prepare('SELECT source_identity, backup_name, completed_at FROM backup_state WHERE singleton = 1')
      .get() as unknown as LastBackup | undefined;
    let previousInvalidBackup: string | undefined;
    if (previous?.source_identity === source.identity && !Number.isSafeInteger(previous.completed_at + intervalMs)) {
      throw new BackupError('Invalid backup cadence record');
    }
    if (previous?.source_identity === source.identity && now < previous.completed_at + intervalMs) {
      const checked = verifiedPrevious(namespace, previous);
      if (checked.valid) {
        sourceIdentity(db, configuration.sourceDatabasePath);
        state.exec('COMMIT'); claimed = false;
        return {
          status: 'not_due', path: checked.path, completedAt: previous.completed_at,
          nextDueAt: previous.completed_at + intervalMs,
        };
      }
      previousInvalidBackup = checked.path;
    }
    const name = `${now}-${randomUUID()}.sqlite`;
    backupPath = join(namespace, name);
    createPrivateFile(backupPath);
    db.prepare('VACUUM main INTO ?').run(backupPath);
    sourceIdentity(db, configuration.sourceDatabasePath);
    verifySnapshot(backupPath);
    syncPath(backupPath);
    syncPath(namespace);
    state.prepare(`INSERT INTO backup_state (singleton, source_identity, backup_name, completed_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET source_identity = excluded.source_identity,
        backup_name = excluded.backup_name, completed_at = excluded.completed_at`).run(source.identity, name, now);
    sourceIdentity(db, configuration.sourceDatabasePath);
    state.exec('COMMIT'); claimed = false;
    return { status: 'created', path: backupPath, completedAt: now, nextDueAt: now + intervalMs, previousInvalidBackup };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BackupError(
      backupPath ? `Backup failed (${detail}); any output is preserved at ${backupPath}` : `Backup coordination failed: ${detail}`,
      backupPath, { cause: error },
    );
  } finally {
    try { if (claimed) state.exec('ROLLBACK'); } finally { state.close(); }
  }
}
