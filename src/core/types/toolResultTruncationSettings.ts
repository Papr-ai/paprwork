/**
 * User-configurable tool result truncation (Settings → AI Models → Agent Context).
 */

export interface ToolResultTruncationSettings {
  /**
   * When true, cross-turn history loading keeps full tool results (no category limits).
   * In-flight absolute cap on fresh pi-ai appends is also skipped.
   * Mid-turn stale-batch compaction is controlled separately by midTurnCompactionEnabled.
   * Full payloads remain in SQLite regardless.
   */
  disableAllTruncation: boolean;
  /** bash, browser, job logs, directory lists (when older than retention window). */
  aggressiveMaxChars: number;
  /** code summaries, plans, schemas, small CRUD. */
  moderateMaxChars: number;
  /** memory / graph search (when not in recent-discovery window). */
  memorySearchMaxChars: number;
  /** User turns before bash/discovery results use aggressive limit (cross-turn). */
  recentTurnRetentionCount: number;
  /**
   * Compact older tool batches within the same assistant response (independent of
   * disableAllTruncation — you can keep full cross-turn history while still
   * trimming stale batches inside a long tool loop).
   */
  midTurnCompactionEnabled: boolean;
  /** Hard ceiling per tool result when truncation is enabled (null = no ceiling). */
  absoluteMaxChars: number | null;
}

export const DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS: ToolResultTruncationSettings =
  {
    disableAllTruncation: false,
    aggressiveMaxChars: 400,
    moderateMaxChars: 2000,
    memorySearchMaxChars: 800,
    recentTurnRetentionCount: 4,
    midTurnCompactionEnabled: true,
    absoluteMaxChars: 40_000,
  };

export function mergeToolResultTruncationSettings(
  saved: Partial<ToolResultTruncationSettings> | undefined,
): ToolResultTruncationSettings {
  return {
    ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
    ...saved,
  };
}
