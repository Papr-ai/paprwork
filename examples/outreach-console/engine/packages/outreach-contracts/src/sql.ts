/**
 * Synchronous SQLite-dialect database port. `@splitin/outreach-store-sqlite` provides drivers and
 * migrations; the core and importer write their queries against this port.
 *
 * Transactions are synchronous on purpose: a transaction can never span an `await`, so provider
 * calls always happen outside them (BUILD_PLAN.md §6.6).
 */
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlRunResult {
  readonly changes: number;
}

export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult;
  get<T = Record<string, unknown>>(...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(...params: SqlValue[]): T[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Outermost call runs `BEGIN IMMEDIATE`; nested calls use savepoints. `fn` must be synchronous. */
  transaction<T>(fn: () => T): T;
  close(): void;
}
