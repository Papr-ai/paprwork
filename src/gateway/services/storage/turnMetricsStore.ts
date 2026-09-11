/**
 * Per-turn metrics as columns on `messages`.
 *
 * Columns rather than a JSON blob because the whole point of collecting these
 * is to aggregate them — `AVG(turn_steps)` and `SUM(turn_redundant_recoveries)`
 * against a 3GB database should not have to parse JSON per row, and the
 * `json_extract` route already needs a `json_valid()` guard here because a
 * fraction of stored payloads are malformed.
 *
 * Every column is a nullable INTEGER, so the migration is metadata-only and
 * turns recorded before this shipped simply read NULL.
 */

import type Database from "better-sqlite3";
import type { TurnMetricsSummary } from "../agent/turnMetrics.js";

const TURN_METRIC_COLUMNS = [
  { name: "turn_steps", sql: "INTEGER" },
  { name: "turn_tool_calls", sql: "INTEGER" },
  { name: "turn_compaction_runs", sql: "INTEGER" },
  { name: "turn_compaction_skips", sql: "INTEGER" },
  { name: "turn_stale_truncated", sql: "INTEGER" },
  { name: "turn_stale_inline", sql: "INTEGER" },
  { name: "turn_recovery_fetches", sql: "INTEGER" },
  { name: "turn_redundant_recoveries", sql: "INTEGER" },
  { name: "turn_recovered_chars", sql: "INTEGER" },
  { name: "turn_peak_context_tokens", sql: "INTEGER" },
  { name: "turn_estimated_context_tokens", sql: "INTEGER" },
  { name: "turn_context_budget_tokens", sql: "INTEGER" },
  { name: "turn_plan_total_steps", sql: "INTEGER" },
  { name: "turn_plan_completed_steps", sql: "INTEGER" },
  { name: "turn_duration_ms", sql: "INTEGER" },
] as const;

export function migrateTurnMetricsColumns(db: Database.Database): void {
  const columns = db.pragma("table_info(messages)") as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  for (const column of TURN_METRIC_COLUMNS) {
    if (!names.has(column.name)) {
      console.log(`[TurnMetrics] Adding "${column.name}" column to messages...`);
      db.exec(`ALTER TABLE messages ADD COLUMN ${column.name} ${column.sql}`);
    }
  }
}

export function storeTurnMetrics(
  db: Database.Database,
  messageId: string,
  summary: TurnMetricsSummary,
  durationMs?: number,
): void {
  db.prepare(
    `UPDATE messages
     SET turn_steps = ?,
         turn_tool_calls = ?,
         turn_compaction_runs = ?,
         turn_compaction_skips = ?,
         turn_stale_truncated = ?,
         turn_stale_inline = ?,
         turn_recovery_fetches = ?,
         turn_redundant_recoveries = ?,
         turn_recovered_chars = ?,
         turn_peak_context_tokens = ?,
         turn_estimated_context_tokens = ?,
         turn_context_budget_tokens = ?,
         turn_plan_total_steps = ?,
         turn_plan_completed_steps = ?,
         turn_duration_ms = ?
     WHERE id = ?`,
  ).run(
    summary.steps,
    summary.toolCalls,
    summary.compactionRuns,
    summary.compactionSkips,
    summary.staleResultsTruncated,
    summary.staleResultsLeftInline,
    summary.recoveryFetches,
    summary.redundantRecoveries,
    summary.recoveredChars,
    summary.peakContextTokens,
    summary.estimatedContextTokens,
    summary.historyTokenBudget,
    summary.planTotalSteps,
    summary.planCompletedSteps,
    durationMs ?? null,
    messageId,
  );
}

/**
 * One turn's measured usage, for the context meter.
 *
 * Read straight off the last assistant row rather than re-estimated, because
 * `prompt_tokens` is what the provider actually billed for the context this
 * chat carries — an estimate would disagree with the invoice.
 */
export interface TurnUsageRow {
  messageId: string;
  model: string | null;
  timestamp: string | null;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  steps: number | null;
  toolCalls: number | null;
  durationMs: number | null;
  compactionRuns: number | null;
  compactionSkips: number | null;
  recoveryFetches: number | null;
  redundantRecoveries: number | null;
  peakContextTokens: number | null;
  contextBudgetTokens: number | null;
}

export interface ChatUsageTotals {
  turns: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
}

const TURN_USAGE_SELECT = `
  SELECT id, model, timestamp,
         COALESCE(prompt_tokens, 0) AS prompt_tokens,
         COALESCE(completion_tokens, 0) AS completion_tokens,
         COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
         COALESCE(cache_write_tokens, 0) AS cache_write_tokens,
         COALESCE(cost, 0) AS cost,
         turn_steps, turn_tool_calls, turn_duration_ms,
         turn_compaction_runs, turn_compaction_skips,
         turn_recovery_fetches, turn_redundant_recoveries,
         turn_peak_context_tokens, turn_context_budget_tokens
  FROM messages
  WHERE chat_id = ? AND role = 'assistant' AND COALESCE(prompt_tokens, 0) > 0
  ORDER BY sequence DESC, timestamp DESC
  LIMIT 1`;

/** Last billed assistant turn in a chat, or null before the first reply. */
export function readLastTurnUsage(
  db: Database.Database,
  chatId: string,
): TurnUsageRow | null {
  const row = db.prepare(TURN_USAGE_SELECT).get(chatId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const int = (key: string): number | null => {
    const value = row[key];
    return typeof value === "number" ? value : null;
  };

  return {
    messageId: String(row.id),
    model: typeof row.model === "string" ? row.model : null,
    timestamp: typeof row.timestamp === "string" ? row.timestamp : null,
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    cost: Number(row.cost ?? 0),
    steps: int("turn_steps"),
    toolCalls: int("turn_tool_calls"),
    durationMs: int("turn_duration_ms"),
    compactionRuns: int("turn_compaction_runs"),
    compactionSkips: int("turn_compaction_skips"),
    recoveryFetches: int("turn_recovery_fetches"),
    redundantRecoveries: int("turn_redundant_recoveries"),
    peakContextTokens: int("turn_peak_context_tokens"),
    contextBudgetTokens: int("turn_context_budget_tokens"),
  };
}

/** Whole-chat rollup. Turns are billed assistant rows, not messages. */
export function readChatUsageTotals(
  db: Database.Database,
  chatId: string,
): ChatUsageTotals {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS turns,
              COALESCE(SUM(cost), 0) AS cost,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
       FROM messages
       WHERE chat_id = ? AND role = 'assistant' AND COALESCE(prompt_tokens, 0) > 0`,
    )
    .get(chatId) as Record<string, unknown> | undefined;

  return {
    turns: Number(row?.turns ?? 0),
    cost: Number(row?.cost ?? 0),
    promptTokens: Number(row?.prompt_tokens ?? 0),
    completionTokens: Number(row?.completion_tokens ?? 0),
    cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
  };
}
