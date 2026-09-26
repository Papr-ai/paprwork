/**
 * Apply ONE migration as ONE transaction: every statement plus the ledger row
 * commit together, or nothing does.
 *
 * Before this, each statement was sent on its own. A failure part-way through
 * left the earlier statements applied and the ledger empty, so the next run
 * replayed the migration against a schema that already had half of it -- the
 * failure mode behind "no such column: prospect_id" on fork installs.
 *
 * Each backend (better-sqlite3, the replica sync worker, the Turso primary over
 * @libsql/client) supplies a MigrationTx bound to an open transaction. The
 * statement guard runs INSIDE that transaction, so the "already done?" check
 * and the write see exactly the same schema.
 */

import {
  guardStatement,
  type GuardOptions,
  type SchemaInspector,
} from "./migrationStatementGuard.js";

export interface MigrationTxStatement {
  sql: string;
  params?: unknown[];
}

/** Minimal surface of an open transaction. */
export interface MigrationTx {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
}

export interface AtomicMigrationResult {
  executed: string[];
  skipped: Array<{ statement: string; reason: string }>;
}

function rowValue(row: Record<string, unknown>, key: string): unknown {
  if (key in row) {
    return row[key];
  }
  const values = Object.values(row);
  return values.length > 0 ? values[0] : undefined;
}

export function schemaInspectorForTx(tx: MigrationTx): SchemaInspector {
  return {
    async objectExists(type, name) {
      const rows = await tx.query(
        "SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ? COLLATE NOCASE LIMIT 1",
        [type, name],
      );
      return rows.length > 0;
    },
    async columnExists(table, column) {
      const rows = await tx.query(
        "SELECT name FROM pragma_table_info(?)",
        [table],
      );
      const wanted = column.toLowerCase();
      return rows.some((row) => String(rowValue(row, "name") ?? "").toLowerCase() === wanted);
    },
  };
}

/**
 * Run `statements` then `ledger` inside the caller's open transaction.
 * Throws on the first real failure; the caller rolls back.
 */
export async function applyMigrationInTx(
  tx: MigrationTx,
  statements: readonly string[],
  ledger: readonly MigrationTxStatement[],
  options: GuardOptions = {},
): Promise<AtomicMigrationResult> {
  const inspector = schemaInspectorForTx(tx);
  const result: AtomicMigrationResult = { executed: [], skipped: [] };

  for (const statement of statements) {
    const decision = await guardStatement(statement, inspector, options);
    if (decision.action === "skip") {
      result.skipped.push({ statement, reason: decision.reason });
      continue;
    }
    try {
      await tx.run(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MigrationStatementError(statement, message);
    }
    result.executed.push(statement);
  }

  for (const entry of ledger) {
    await tx.run(entry.sql, entry.params);
  }
  return result;
}

export class MigrationStatementError extends Error {
  constructor(
    readonly statement: string,
    readonly causeMessage: string,
  ) {
    const excerpt = statement.length > 120 ? `${statement.slice(0, 117)}…` : statement;
    super(
      `${causeMessage} — while running: ${excerpt}. ` +
        "The migration was rolled back; the database is unchanged.",
    );
    this.name = "MigrationStatementError";
  }
}

/** Ledger rows written in the same transaction as the migration. */
export function localLedgerStatements(ledgerId: string): MigrationTxStatement[] {
  return [
    {
      sql: "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    },
    {
      sql: "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))",
      params: [ledgerId],
    },
  ];
}
