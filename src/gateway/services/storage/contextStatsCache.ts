import type Database from "better-sqlite3";

const STATS_ROW_ID = 1;

export interface CachedLifetimeProjection {
  measuredPromptTokens: number;
  projectedPromptTokens: number;
  completionTokens: number;
  totalTokensConsumed: number;
  computedTurns: number;
  pendingTurns: number;
  computedPromptTokens: number;
  pendingPromptTokens: number;
  chatsWithBilling: number;
}

interface ContextStatsRow {
  measured_prompt_tokens: number;
  projected_prompt_tokens: number;
  completion_tokens: number;
  total_tokens_consumed: number;
  computed_turns: number;
  pending_turns: number;
  computed_prompt_tokens: number;
  pending_prompt_tokens: number;
  chats_with_billing: number;
  needs_rebuild: number;
}

const EMPTY_STATS_ROW: ContextStatsRow = {
  measured_prompt_tokens: 0,
  projected_prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens_consumed: 0,
  computed_turns: 0,
  pending_turns: 0,
  computed_prompt_tokens: 0,
  pending_prompt_tokens: 0,
  chats_with_billing: 0,
  needs_rebuild: 1,
};

let statsRebuildRunning = false;

export function migrateContextStatsCache(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_stats (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      measured_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      projected_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens_consumed INTEGER NOT NULL DEFAULT 0,
      computed_turns INTEGER NOT NULL DEFAULT 0,
      pending_turns INTEGER NOT NULL DEFAULT 0,
      computed_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      pending_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      chats_with_billing INTEGER NOT NULL DEFAULT 0,
      needs_rebuild INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS context_stats_billing_chats (
      chat_id TEXT PRIMARY KEY
    );
  `);

  db.prepare(
    `INSERT OR IGNORE INTO context_stats (id, needs_rebuild) VALUES (?, 1)`,
  ).run(STATS_ROW_ID);
}

function readStatsRow(db: Database.Database): ContextStatsRow {
  const row = db
    .prepare(
      `SELECT measured_prompt_tokens, projected_prompt_tokens, completion_tokens,
              total_tokens_consumed, computed_turns, pending_turns,
              computed_prompt_tokens, pending_prompt_tokens,
              chats_with_billing, needs_rebuild
       FROM context_stats WHERE id = ?`,
    )
    .get(STATS_ROW_ID) as ContextStatsRow | undefined;

  return row ?? EMPTY_STATS_ROW;
}

export function readContextStatsCache(
  db: Database.Database,
): CachedLifetimeProjection & { needsRebuild: boolean } {
  const row = readStatsRow(db);
  return {
    measuredPromptTokens: row.measured_prompt_tokens ?? 0,
    projectedPromptTokens: row.projected_prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    totalTokensConsumed: row.total_tokens_consumed ?? 0,
    computedTurns: row.computed_turns ?? 0,
    pendingTurns: row.pending_turns ?? 0,
    computedPromptTokens: row.computed_prompt_tokens ?? 0,
    pendingPromptTokens: row.pending_prompt_tokens ?? 0,
    chatsWithBilling: row.chats_with_billing ?? 0,
    needsRebuild: (row.needs_rebuild ?? 1) === 1,
  };
}

export function recordMessageTokensInCache(
  db: Database.Database,
  chatId: string,
  role: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): void {
  db.prepare(
    `UPDATE context_stats
     SET total_tokens_consumed = total_tokens_consumed + ?
     WHERE id = ?`,
  ).run(totalTokens, STATS_ROW_ID);

  if (role !== "assistant" || promptTokens <= 0) {
    return;
  }

  db.prepare(
    `UPDATE context_stats
     SET measured_prompt_tokens = measured_prompt_tokens + ?,
         completion_tokens = completion_tokens + ?,
         pending_turns = pending_turns + 1,
         pending_prompt_tokens = pending_prompt_tokens + ?
     WHERE id = ?`,
  ).run(promptTokens, completionTokens, promptTokens, STATS_ROW_ID);

  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO context_stats_billing_chats (chat_id) VALUES (?)`,
    )
    .run(chatId);
  if (inserted.changes > 0) {
    db.prepare(
      `UPDATE context_stats
       SET chats_with_billing = chats_with_billing + 1
       WHERE id = ?`,
    ).run(STATS_ROW_ID);
  }
}

export function applyFootprintStoredInCache(
  db: Database.Database,
  promptTokens: number,
  hypotheticalPromptTokens: number,
): void {
  if (promptTokens <= 0) return;

  db.prepare(
    `UPDATE context_stats
     SET pending_turns = MAX(0, pending_turns - 1),
         pending_prompt_tokens = MAX(0, pending_prompt_tokens - ?),
         computed_turns = computed_turns + 1,
         computed_prompt_tokens = computed_prompt_tokens + ?,
         projected_prompt_tokens = projected_prompt_tokens + ?
     WHERE id = ?`,
  ).run(promptTokens, promptTokens, hypotheticalPromptTokens, STATS_ROW_ID);
}

export function adjustCacheForInvalidatedChat(
  db: Database.Database,
  chatId: string,
): void {
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS computed_turns,
         COALESCE(SUM(prompt_tokens), 0) AS prompt_sum,
         COALESCE(SUM(hypothetical_prompt_tokens), 0) AS projected_sum
       FROM messages
       WHERE chat_id = ?
         AND role = 'assistant'
         AND prompt_tokens > 0
         AND hypothetical_prompt_tokens IS NOT NULL`,
    )
    .get(chatId) as {
    computed_turns: number;
    prompt_sum: number;
    projected_sum: number;
  };

  const computedTurns = totals.computed_turns ?? 0;
  if (computedTurns === 0) return;

  const promptSum = totals.prompt_sum ?? 0;
  const projectedSum = totals.projected_sum ?? 0;

  db.prepare(
    `UPDATE context_stats
     SET computed_turns = MAX(0, computed_turns - ?),
         computed_prompt_tokens = MAX(0, computed_prompt_tokens - ?),
         projected_prompt_tokens = MAX(0, projected_prompt_tokens - ?),
         pending_turns = pending_turns + ?,
         pending_prompt_tokens = pending_prompt_tokens + ?
     WHERE id = ?`,
  ).run(
    computedTurns,
    promptSum,
    projectedSum,
    computedTurns,
    promptSum,
    STATS_ROW_ID,
  );
}

function rebuildContextStatsFromMessages(db: Database.Database): void {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN role = 'assistant' THEN prompt_tokens ELSE 0 END), 0)
           AS measured_prompt,
         COALESCE(SUM(CASE WHEN role = 'assistant' THEN completion_tokens ELSE 0 END), 0)
           AS completion,
         COALESCE(SUM(total_tokens), 0) AS total,
         COALESCE(SUM(hypothetical_prompt_tokens), 0) AS projected,
         COALESCE(SUM(
           CASE
             WHEN role = 'assistant'
               AND prompt_tokens > 0
               AND hypothetical_prompt_tokens IS NOT NULL
             THEN prompt_tokens ELSE 0
           END
         ), 0) AS computed_prompt,
         COALESCE(SUM(
           CASE
             WHEN role = 'assistant'
               AND prompt_tokens > 0
               AND hypothetical_prompt_tokens IS NULL
             THEN prompt_tokens ELSE 0
           END
         ), 0) AS pending_prompt,
         SUM(
           CASE
             WHEN role = 'assistant'
               AND prompt_tokens > 0
               AND hypothetical_prompt_tokens IS NOT NULL
             THEN 1 ELSE 0
           END
         ) AS computed_turns,
         SUM(
           CASE
             WHEN role = 'assistant'
               AND prompt_tokens > 0
               AND hypothetical_prompt_tokens IS NULL
             THEN 1 ELSE 0
           END
         ) AS pending_turns,
         COUNT(
           DISTINCT CASE
             WHEN role = 'assistant' AND prompt_tokens > 0 THEN chat_id
           END
         ) AS chats_with_billing
       FROM messages`,
    )
    .get() as {
    measured_prompt: number;
    completion: number;
    total: number;
    projected: number;
    computed_prompt: number;
    pending_prompt: number;
    computed_turns: number;
    pending_turns: number;
    chats_with_billing: number;
  };

  db.prepare(
    `UPDATE context_stats
     SET measured_prompt_tokens = ?,
         projected_prompt_tokens = ?,
         completion_tokens = ?,
         total_tokens_consumed = ?,
         computed_turns = ?,
         pending_turns = ?,
         computed_prompt_tokens = ?,
         pending_prompt_tokens = ?,
         chats_with_billing = ?,
         needs_rebuild = 0
     WHERE id = ?`,
  ).run(
    row.measured_prompt ?? 0,
    row.projected ?? 0,
    row.completion ?? 0,
    row.total ?? 0,
    row.computed_turns ?? 0,
    row.pending_turns ?? 0,
    row.computed_prompt ?? 0,
    row.pending_prompt ?? 0,
    row.chats_with_billing ?? 0,
    STATS_ROW_ID,
  );

  db.exec(`DELETE FROM context_stats_billing_chats`);
  db.exec(`
    INSERT INTO context_stats_billing_chats (chat_id)
    SELECT DISTINCT chat_id
    FROM messages
    WHERE role = 'assistant' AND prompt_tokens > 0
  `);
}

/** Synchronous rebuild — used by async scheduler and tests. */
export function rebuildContextStatsCacheNow(db: Database.Database): void {
  rebuildContextStatsFromMessages(db);
}

export function scheduleContextStatsRebuild(db: Database.Database): void {
  const stats = readContextStatsCache(db);
  if (!stats.needsRebuild || statsRebuildRunning) return;

  statsRebuildRunning = true;
  setImmediate(() => {
    try {
      console.log("[ContextStats] Rebuilding lifetime stats cache (one-time)...");
      const started = Date.now();
      rebuildContextStatsFromMessages(db);
      console.log(
        `[ContextStats] Cache rebuild complete (${Date.now() - started}ms)`,
      );
    } catch (error) {
      console.error("[ContextStats] Cache rebuild failed:", error);
    } finally {
      statsRebuildRunning = false;
    }
  });
}

export function hasPendingFootprintWork(db: Database.Database): boolean {
  const stats = readContextStatsCache(db);
  if (stats.needsRebuild) {
    return (
      db
        .prepare(
          `SELECT 1 FROM messages
         WHERE role = 'assistant'
           AND prompt_tokens > 0
           AND hypothetical_prompt_tokens IS NULL
         LIMIT 1`,
        )
        .get() !== undefined
    );
  }
  return stats.pendingTurns > 0;
}

export function isContextStatsCacheReady(db: Database.Database): boolean {
  return !readContextStatsCache(db).needsRebuild;
}
