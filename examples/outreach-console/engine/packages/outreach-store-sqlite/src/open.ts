import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase } from '@splitin/outreach-contracts';
import { wrapNativeDatabase, type NativeDatabase } from './driver';
import { migrate } from './migrate';
import { openWithBackupIdentity } from './backup';

export interface OpenOptions {
  /** Apply pending migrations after opening (default true). */
  readonly migrate?: boolean;
  readonly busyTimeoutMs?: number;
}

function configure(db: SqlDatabase, path: string, busyTimeoutMs: number): void {
  // busy_timeout first: `journal_mode` needs a lock, and another process closing the last connection holds an
  // exclusive one while it checkpoints. Without a timeout already in place, opening then fails at once with
  // "database is locked" instead of waiting (seen in the multi-process soak).
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
}

/** Opens (and by default migrates) a database with the built-in node:sqlite driver. */
export function openSqliteDatabase(path: string, options: OpenOptions = {}): SqlDatabase {
  const db = openWithBackupIdentity(path, (canonicalPath) =>
    wrapNativeDatabase(new DatabaseSync(canonicalPath) as unknown as NativeDatabase));
  configure(db, path, options.busyTimeoutMs ?? 5_000);
  if (options.migrate ?? true) migrate(db);
  return db;
}

/**
 * Adapts an already-open better-sqlite3 handle (what Papr Work loads in Electron).
 * Kept structural so this package does not depend on the native module.
 * Backups require open-time file provenance and do not accept already-open adapted handles.
 */
export function fromBetterSqlite3(native: NativeDatabase, path: string, options: OpenOptions = {}): SqlDatabase {
  const db = wrapNativeDatabase(native);
  configure(db, path, options.busyTimeoutMs ?? 5_000);
  if (options.migrate ?? true) migrate(db);
  return db;
}
