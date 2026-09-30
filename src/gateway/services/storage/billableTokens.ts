import type Database from "better-sqlite3";

export interface BillableTokenTotals {
  prompt_tokens: number;
  completion_tokens: number;
}

export function sumBillableTokens(
  promptTokens: number,
  completionTokens: number,
): number {
  return promptTokens + completionTokens;
}

/** Billable API usage = prompt + completion (excludes context-window placeholders). */
export function readBillableTokenTotals(
  db: Database.Database,
  sinceIso?: string,
): { promptTokens: number; completionTokens: number } {
  const row = sinceIso
    ? (db
        .prepare(
          `SELECT
             COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) AS completion_tokens
           FROM messages
           WHERE role = 'assistant'
             AND prompt_tokens > 0
             AND timestamp >= ?`,
        )
        .get(sinceIso) as BillableTokenTotals | undefined)
    : (db
        .prepare(
          `SELECT
             COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) AS completion_tokens
           FROM messages
           WHERE role = 'assistant'
             AND prompt_tokens > 0`,
        )
        .get() as BillableTokenTotals | undefined);

  return {
    promptTokens: row?.prompt_tokens ?? 0,
    completionTokens: row?.completion_tokens ?? 0,
  };
}

export function periodStartIso(
  period: "today" | "week" | "month",
  now = new Date(),
): string {
  if (period === "today") {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).toISOString();
  }
  if (period === "week") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}
