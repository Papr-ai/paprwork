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
    summary.historyTokenBudget,
    summary.planTotalSteps,
    summary.planCompletedSteps,
    durationMs ?? null,
    messageId,
  );
}
