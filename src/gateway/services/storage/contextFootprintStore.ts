import type Database from "better-sqlite3";
import {
  computeSingleTurnFootprint,
  type ChatContextRow,
  type StoredMessageRow,
} from "./contextFootprint.js";

const FOOTPRINT_COLUMNS = [
  { name: "hypothetical_prompt_tokens", sql: "INTEGER" },
  { name: "context_naive_tokens", sql: "INTEGER" },
  { name: "context_optimized_tokens", sql: "INTEGER" },
  { name: "context_footprint_at", sql: "TEXT" },
] as const;

type MessageRowWithMeta = StoredMessageRow & {
  id: string;
  role: string;
  prompt_tokens: number | null;
  timestamp: string;
};

export function migrateFootprintColumns(db: Database.Database): void {
  const columns = db.pragma("table_info(messages)") as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  for (const column of FOOTPRINT_COLUMNS) {
    if (!names.has(column.name)) {
      console.log(
        `[ContextFootprint] Adding "${column.name}" column to messages...`,
      );
      db.exec(`ALTER TABLE messages ADD COLUMN ${column.name} ${column.sql}`);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_pending_footprint
    ON messages(chat_id)
    WHERE role = 'assistant'
      AND prompt_tokens > 0
      AND hypothetical_prompt_tokens IS NULL
  `);
}

function fetchChatContext(
  db: Database.Database,
  chatId: string,
): ChatContextRow | undefined {
  return db
    .prepare(
      `SELECT id, message_count, title,
              summary_short, summary_medium, summary_long,
              summary_topics, summary_enhanced, summary_last_updated
       FROM chats WHERE id = ?`,
    )
    .get(chatId) as ChatContextRow | undefined;
}

function toStoredHistory(messages: MessageRowWithMeta[]): StoredMessageRow[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    thinking: message.thinking,
    tool_calls: message.tool_calls,
  }));
}

export function invalidateChatFootprints(
  db: Database.Database,
  chatId: string,
): void {
  db.prepare(
    `UPDATE messages
     SET hypothetical_prompt_tokens = NULL,
         context_naive_tokens = NULL,
         context_optimized_tokens = NULL,
         context_footprint_at = NULL
     WHERE chat_id = ?`,
  ).run(chatId);
}

export function backfillChatFootprints(
  db: Database.Database,
  chatId: string,
): number {
  const chat = fetchChatContext(db, chatId);
  if (!chat) return 0;

  const messages = db
    .prepare(
      `SELECT id, role, content, thinking, tool_calls, prompt_tokens, timestamp
       FROM messages
       WHERE chat_id = ?
       ORDER BY timestamp ASC`,
    )
    .all(chatId) as MessageRowWithMeta[];

  const update = db.prepare(
    `UPDATE messages
     SET hypothetical_prompt_tokens = ?,
         context_naive_tokens = ?,
         context_optimized_tokens = ?,
         context_footprint_at = ?
     WHERE id = ?`,
  );

  let updated = 0;
  const computedAt = new Date().toISOString();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const promptTokens = message.prompt_tokens ?? 0;
    if (promptTokens <= 0) continue;

    const footprint = computeSingleTurnFootprint(
      chat,
      toStoredHistory(messages.slice(0, i)),
      promptTokens,
    );

    update.run(
      footprint.hypotheticalPromptTokens,
      footprint.contextNaiveTokens,
      footprint.contextOptimizedTokens,
      computedAt,
      message.id,
    );
    updated += 1;
  }

  return updated;
}

export function storeFootprintForNewMessage(
  db: Database.Database,
  chatId: string,
  messageId: string,
  promptTokens: number,
): void {
  if (promptTokens <= 0) return;

  const chat = fetchChatContext(db, chatId);
  if (!chat) return;

  const target = db
    .prepare(`SELECT timestamp FROM messages WHERE id = ?`)
    .get(messageId) as { timestamp: string } | undefined;
  if (!target) return;

  const history = db
    .prepare(
      `SELECT role, content, thinking, tool_calls
       FROM messages
       WHERE chat_id = ? AND timestamp < ?
       ORDER BY timestamp ASC`,
    )
    .all(chatId, target.timestamp) as StoredMessageRow[];

  const footprint = computeSingleTurnFootprint(chat, history, promptTokens);

  db.prepare(
    `UPDATE messages
     SET hypothetical_prompt_tokens = ?,
         context_naive_tokens = ?,
         context_optimized_tokens = ?,
         context_footprint_at = ?
     WHERE id = ?`,
  ).run(
    footprint.hypotheticalPromptTokens,
    footprint.contextNaiveTokens,
    footprint.contextOptimizedTokens,
    new Date().toISOString(),
    messageId,
  );
}

export interface CachedLifetimeProjection {
  measuredPromptTokens: number;
  projectedPromptTokens: number;
  completionTokens: number;
  totalTokensConsumed: number;
  computedTurns: number;
  pendingTurns: number;
  chatsWithBilling: number;
}

export function readCachedLifetimeProjection(
  db: Database.Database,
): CachedLifetimeProjection {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN role = 'assistant' THEN prompt_tokens ELSE 0 END), 0)
           AS measured_prompt,
         COALESCE(SUM(CASE WHEN role = 'assistant' THEN completion_tokens ELSE 0 END), 0)
           AS completion,
         COALESCE(SUM(CASE WHEN role = 'assistant' THEN total_tokens ELSE 0 END), 0)
           AS total,
         COALESCE(SUM(hypothetical_prompt_tokens), 0) AS projected,
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
    computed_turns: number;
    pending_turns: number;
    chats_with_billing: number;
  };

  return {
    measuredPromptTokens: row.measured_prompt ?? 0,
    projectedPromptTokens: row.projected ?? 0,
    completionTokens: row.completion ?? 0,
    totalTokensConsumed: row.total ?? 0,
    computedTurns: row.computed_turns ?? 0,
    pendingTurns: row.pending_turns ?? 0,
    chatsWithBilling: row.chats_with_billing ?? 0,
  };
}

export function estimatePartialProjection(
  db: Database.Database,
  cached: CachedLifetimeProjection,
): number {
  const computedPromptRow = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens
       FROM messages
       WHERE role = 'assistant'
         AND prompt_tokens > 0
         AND hypothetical_prompt_tokens IS NOT NULL`,
    )
    .get() as { prompt_tokens: number };

  const pendingPromptRow = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens
       FROM messages
       WHERE role = 'assistant'
         AND prompt_tokens > 0
         AND hypothetical_prompt_tokens IS NULL`,
    )
    .get() as { prompt_tokens: number };

  const computedPrompt = computedPromptRow.prompt_tokens ?? 0;
  const pendingPrompt = pendingPromptRow.prompt_tokens ?? 0;

  if (pendingPrompt <= 0) {
    return cached.projectedPromptTokens;
  }

  const avgInflation =
    computedPrompt > 0
      ? cached.projectedPromptTokens / computedPrompt
      : 1;

  return (
    cached.projectedPromptTokens +
    Math.round(pendingPrompt * Math.max(1, avgInflation))
  );
}

let backfillRunning = false;

export function isContextFootprintBackfillRunning(): boolean {
  return backfillRunning;
}

export function scheduleContextFootprintBackfill(
  db: Database.Database,
  options?: {
    chatsPerBatch?: number;
    onBatchComplete?: (updated: number, pending: number) => void;
  },
): void {
  if (backfillRunning) return;

  const pending = readCachedLifetimeProjection(db).pendingTurns;
  if (pending === 0) return;

  backfillRunning = true;
  const chatsPerBatch = options?.chatsPerBatch ?? 5;

  setImmediate(() => {
    const runBatch = (): void => {
      try {
        const chatIds = db
          .prepare(
            `SELECT DISTINCT chat_id
             FROM messages
             WHERE role = 'assistant'
               AND prompt_tokens > 0
               AND hypothetical_prompt_tokens IS NULL
             LIMIT ?`,
          )
          .all(chatsPerBatch) as Array<{ chat_id: string }>;

        if (chatIds.length === 0) {
          backfillRunning = false;
          console.log("[ContextFootprint] Backfill complete");
          return;
        }

        let updated = 0;
        for (const { chat_id: chatId } of chatIds) {
          updated += backfillChatFootprints(db, chatId);
        }

        const remaining = readCachedLifetimeProjection(db).pendingTurns;
        console.log(
          `[ContextFootprint] Backfill batch: ${updated} turns, ${remaining} pending`,
        );
        options?.onBatchComplete?.(updated, remaining);

        if (remaining > 0) {
          setImmediate(runBatch);
        } else {
          backfillRunning = false;
          console.log("[ContextFootprint] Backfill complete");
        }
      } catch (error) {
        backfillRunning = false;
        console.error("[ContextFootprint] Backfill failed:", error);
      }
    };

    console.log(
      `[ContextFootprint] Starting backfill (${pending} pending turns)`,
    );
    runBatch();
  });
}
