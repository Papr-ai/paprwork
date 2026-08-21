/**
 * Replay-safe SQL enforcement for /api/db/write row ops.
 */

const NON_IDEMPOTENT_UPDATE = /\w+\s*=\s*\w+\s*[\+\-\*\/]/i;

export class NonReplaySafeSqlError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "NonReplaySafeSqlError";
  }
}

export function assertReplaySafeRowSql(sql: string): void {
  const trimmed = sql.trim();
  if (!/^update/i.test(trimmed)) {
    return;
  }
  if (NON_IDEMPOTENT_UPDATE.test(trimmed)) {
    throw new NonReplaySafeSqlError(
      "Non-idempotent UPDATE (e.g. count=count+1) is not allowed on /api/db/write. " +
        "Use INSERT OR REPLACE, UPSERT, or absolute SET values.",
    );
  }
}
