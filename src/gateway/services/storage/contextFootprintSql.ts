import type Database from "better-sqlite3";
import {
  aggregateChatTurnFootprints,
  aggregateWeightedPromptProjections,
  capInflationRatio,
  computeChatTurnFootprint,
  computeWeightedPromptProjection,
  type AggregatedCumulativeProjection,
  type ChatContextRow,
  type ChatTurnFootprint,
  type MessageWithUsageRow,
  type StoredMessageRow,
} from "./contextFootprint.js";
import { computeRecentMessageLimit } from "./recentMessageWindow.js";
import { boundedPayloadSql } from "./messagePayloadStore.js";

const messageCharExpr = `LENGTH(COALESCE(content, ''))
  + LENGTH(COALESCE(thinking, ''))
  + LENGTH(COALESCE(tool_calls, ''))`;

const TOP_CHATS_LIMIT = 30;
const LARGE_CHAT_THRESHOLD = 400;
/** Chats larger than this use snapshot estimate instead of per-turn replay. */
const LARGE_CHAT_REPLAY_THRESHOLD = 400;

function fetchTopChats(db: Database.Database): ChatContextRow[] {
  return db
    .prepare(
      `SELECT id, message_count, title,
              summary_short, summary_medium, summary_long,
              summary_topics, summary_enhanced, summary_last_updated,
              summary_base_message_count
       FROM chats
       WHERE message_count > 0
       ORDER BY message_count DESC
       LIMIT ${TOP_CHATS_LIMIT}`,
    )
    .all() as ChatContextRow[];
}

/** Every chat with at least one billed assistant turn (prompt_tokens > 0). */
function fetchChatsWithBilling(db: Database.Database): ChatContextRow[] {
  return db
    .prepare(
      `SELECT c.id, c.message_count, c.title,
              c.summary_short, c.summary_medium, c.summary_long,
              c.summary_topics, c.summary_enhanced, c.summary_last_updated,
              c.summary_base_message_count
       FROM chats c
       WHERE c.message_count > 0
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.chat_id = c.id
             AND m.role = 'assistant'
             AND m.prompt_tokens > 0
         )
       ORDER BY c.message_count DESC`,
    )
    .all() as ChatContextRow[];
}

function computeChatFootprintSnapshot(
  db: Database.Database,
  chat: ChatContextRow,
): ChatTurnFootprint {
  const fullCharsStmt = db.prepare(
    `SELECT COALESCE(SUM(${messageCharExpr}), 0) AS chars
     FROM messages WHERE chat_id = ?`,
  );

  const recentMessagesStmt = db.prepare(
    `SELECT role, content, thinking, ${boundedPayloadSql("tool_calls")}
     FROM messages
     WHERE chat_id = ?
     ORDER BY timestamp DESC
     LIMIT ?`,
  );

  const toolCallsStmt = db.prepare(
    `SELECT ${boundedPayloadSql("tool_calls")}
     FROM messages
     WHERE chat_id = ?
       AND role = 'assistant'
       AND tool_calls IS NOT NULL
       AND tool_calls != ''`,
  );

  const hasSummary = Boolean(chat.summary_long);

  if (hasSummary) {
    const recentLimit = computeRecentMessageLimit(
      chat.message_count,
      chat.summary_base_message_count,
    );
    const recentRows = recentMessagesStmt.all(
      chat.id,
      recentLimit,
    ) as StoredMessageRow[];
    recentRows.reverse();
    return computeChatTurnFootprint(chat, recentRows, {
      fullChatCharsOverride: (
        fullCharsStmt.get(chat.id) as { chars: number }
      ).chars,
    });
  }

  const fullChatChars = (
    fullCharsStmt.get(chat.id) as { chars: number }
  ).chars;

  const textCharsRow = db
    .prepare(
      `SELECT COALESCE(SUM(
          LENGTH(COALESCE(content, '')) + LENGTH(COALESCE(thinking, ''))
        ), 0) AS chars
         FROM messages WHERE chat_id = ?`,
    )
    .get(chat.id) as { chars: number };

  if (chat.message_count > LARGE_CHAT_THRESHOLD) {
    const toolStats = db
      .prepare(
        `SELECT
             COUNT(*) AS tool_msg_count,
             COALESCE(SUM(LENGTH(tool_calls)), 0) AS tool_json_chars
           FROM messages
           WHERE chat_id = ?
             AND role = 'assistant'
             AND tool_calls IS NOT NULL
             AND tool_calls != ''`,
      )
      .get(chat.id) as { tool_msg_count: number; tool_json_chars: number };

    const truncatedToolChars = toolStats.tool_msg_count * 400;
    const agentContextChars =
      textCharsRow.chars +
      Math.min(toolStats.tool_json_chars, truncatedToolChars);

    return computeChatTurnFootprint(chat, [], {
      fullChatCharsOverride: fullChatChars,
      textOnlyChars: textCharsRow.chars,
      agentContextCharsOverride: agentContextChars,
    });
  }

  const toolRows = toolCallsStmt.all(chat.id) as Array<{
    tool_calls: string;
  }>;
  const syntheticMessages: StoredMessageRow[] = toolRows.map((row) => ({
    role: "assistant",
    content: "",
    thinking: null,
    tool_calls: row.tool_calls,
  }));

  return computeChatTurnFootprint(chat, syntheticMessages, {
    fullChatCharsOverride: fullChatChars,
    textOnlyChars: textCharsRow.chars,
  });
}

function estimateLargeChatPromptProjection(
  db: Database.Database,
  chat: ChatContextRow,
  footprint: ChatTurnFootprint,
): {
  projectedPromptTokens: number;
  measuredPromptTokens: number;
  assistantTurns: number;
} {
  const usageRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COUNT(*) AS turns
       FROM messages
       WHERE chat_id = ? AND role = 'assistant' AND prompt_tokens > 0`,
    )
    .get(chat.id) as { prompt_tokens: number; turns: number };

  const measuredPromptTokens = usageRow?.prompt_tokens ?? 0;
  const assistantTurns = usageRow?.turns ?? 0;
  const inflationRatio = capInflationRatio(
    footprint.agentContextTokens > 0
      ? footprint.fullChatTokens / footprint.agentContextTokens
      : 1,
  );

  return {
    projectedPromptTokens: Math.round(measuredPromptTokens * inflationRatio),
    measuredPromptTokens,
    assistantTurns,
  };
}

/**
 * Fast path: SQL aggregates for full-chat size; only load message rows
 * needed for per-turn agent context (chunked recent window when summarized).
 */
export function computeTurnFootprintsFast(
  db: Database.Database,
): ReturnType<typeof aggregateChatTurnFootprints> {
  const chats = fetchTopChats(db);
  const footprints = chats.map((chat) =>
    computeChatFootprintSnapshot(db, chat),
  );
  return aggregateChatTurnFootprints(footprints);
}

/**
 * Replay assistant turns with billing data to project lifetime prompt cost
 * without Paprwork context optimizations.
 */
export function computeCumulativeContextProjection(
  db: Database.Database,
): AggregatedCumulativeProjection {
  const chats = fetchChatsWithBilling(db);

  const messagesStmt = db.prepare(
    `SELECT role, content, thinking, ${boundedPayloadSql("tool_calls")}, prompt_tokens
     FROM messages
     WHERE chat_id = ?
     ORDER BY timestamp ASC`,
  );

  const weightedItems = chats.map((chat) => {
    if (chat.message_count > LARGE_CHAT_REPLAY_THRESHOLD) {
      const footprint = computeChatFootprintSnapshot(db, chat);
      return estimateLargeChatPromptProjection(db, chat, footprint);
    }

    const messages = messagesStmt.all(chat.id) as MessageWithUsageRow[];
    return computeWeightedPromptProjection(chat, messages);
  });

  const weighted = aggregateWeightedPromptProjections(weightedItems);

  return {
    cumulativeNaiveContextTokens: 0,
    cumulativeOptimizedContextTokens: 0,
    projectedPromptTokens: weighted.projectedPromptTokens,
    measuredPromptTokens: weighted.measuredPromptTokens,
    chatsAnalyzed: chats.length,
    analyzedAssistantTurns: weighted.analyzedAssistantTurns,
  };
}
