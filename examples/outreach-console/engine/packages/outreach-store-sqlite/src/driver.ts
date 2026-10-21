import type { SqlDatabase, SqlRunResult, SqlStatement, SqlValue } from '@splitin/outreach-contracts';

/** Minimal structural shape shared by node:sqlite's DatabaseSync and better-sqlite3's Database. */
interface NativeStatement {
  run(...params: SqlValue[]): { changes: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

export interface NativeDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): NativeStatement;
  close(): unknown;
}

export class TransactionMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionMisuseError';
  }
}

/**
 * Wraps a native synchronous SQLite handle as the SqlDatabase port: statement caching, and
 * BEGIN IMMEDIATE transactions with savepoints for nesting.
 */
export function wrapNativeDatabase(native: NativeDatabase): SqlDatabase {
  const cache = new Map<string, SqlStatement>();
  let depth = 0;

  const prepare = (sql: string): SqlStatement => {
    const cached = cache.get(sql);
    if (cached) return cached;
    const statement = native.prepare(sql);
    const wrapped: SqlStatement = {
      run: (...params): SqlRunResult => ({ changes: Number(statement.run(...params).changes) }),
      get: <T>(...params: SqlValue[]) => statement.get(...params) as T | undefined,
      all: <T>(...params: SqlValue[]) => statement.all(...params) as T[],
    };
    cache.set(sql, wrapped);
    return wrapped;
  };

  return {
    exec: (sql) => {
      native.exec(sql);
    },
    prepare,
    transaction<T>(fn: () => T): T {
      const savepoint = `sp_${depth}`;
      native.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const result = fn();
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          throw new TransactionMisuseError('transaction callbacks must be synchronous; never await inside one');
        }
        depth -= 1;
        native.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        depth -= 1;
        native.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
    },
    close: () => {
      cache.clear();
      native.close();
    },
  };
}
