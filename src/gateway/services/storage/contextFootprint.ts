import {
  deserializeEnhancedFields,
  formatSummaryForLLM,
} from "./summaryFormatting.js";
import { computeRecentMessageLimit } from "./recentMessageWindow.js";
import { formatPaprPathForAgent } from "../../../core/utils/paprAgentPaths.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import * as path from "path";

import {
  ACTIVE_FILE_READ_MAX_CHARS,
  HISTORY_TOOL_RESULT_MAX_CHARS,
  HISTORY_TOOL_RESULT_MODERATE_CHARS,
} from "../agent/toolResultTruncation.js";

export {
  ACTIVE_FILE_READ_MAX_CHARS,
  HISTORY_TOOL_RESULT_MAX_CHARS,
  HISTORY_TOOL_RESULT_MODERATE_CHARS,
};
export {
  RECENT_MESSAGES_MIN,
  RECENT_MESSAGES_MAX,
  RECENT_MESSAGES_WITH_SUMMARY,
} from "./recentMessageWindow.js";
/** Cap per-turn inflation so lifetime projections stay realistic. */
export const MAX_CONTEXT_INFLATION_RATIO = 15;
const CHARS_PER_TOKEN = 4;

export function capInflationRatio(ratio: number): number {
  return Math.min(MAX_CONTEXT_INFLATION_RATIO, Math.max(1, ratio));
}

export interface StoredMessageRow {
  role: string;
  content: string | null;
  thinking: string | null;
  tool_calls: string | null;
}

export interface ChatContextRow {
  id: string;
  message_count: number;
  title: string | null;
  summary_short: string | null;
  summary_medium: string | null;
  summary_long: string | null;
  summary_topics: string | null;
  summary_enhanced: string | null;
  summary_last_updated: string | null;
  summary_base_message_count: number | null;
}

interface ToolCallRecord {
  name?: string;
  args?: unknown;
  result?: unknown;
  /** Present when `result` is only a preview of a payload kept outside the row. */
  resultOffload?: { totalChars?: number };
}

export interface ChatTurnFootprint {
  chatId: string;
  messageCount: number;
  hasSummary: boolean;
  /** All messages in DB, full tool results — naive per-turn context */
  fullChatTokens: number;
  /** Summary + recent 6 (or all msgs) with history truncation — actual per-turn context */
  agentContextTokens: number;
  truncationTokensSaved: number;
  summaryTokensSaved: number;
  tokensSavedPerTurn: number;
}

function charsToTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN));
}

function stringifyResult(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function truncateToolResult(resultStr: string, maxChars: number | null): string {
  if (maxChars === null || resultStr.length <= maxChars) {
    return resultStr;
  }
  const omitted = resultStr.length - maxChars;
  return (
    resultStr.substring(0, maxChars) +
    `\n[... ${omitted} chars truncated. Tool: get_full_tool_result(...)]`
  );
}

function parseToolCalls(raw: string | null): ToolCallRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ToolCallRecord[]) : [];
  } catch {
    return [];
  }
}

function estimateToolCallsChars(
  toolCalls: ToolCallRecord[],
  truncateResultsAt: number | null,
): number {
  let chars = 0;
  for (const call of toolCalls) {
    if (call.args !== undefined) {
      chars += stringifyResult(call.args).length;
    }
    const storedResult = stringifyResult(call.result);
    if (truncateResultsAt === null) {
      // Untruncated baseline: an offloaded result only keeps a preview in the
      // row, so its real size comes from the offload pointer.
      chars += call.resultOffload?.totalChars ?? storedResult.length;
    } else {
      // What the model actually receives, which is the stored value.
      chars += truncateToolResult(storedResult, truncateResultsAt).length;
    }
    if (typeof call.name === "string") {
      chars += call.name.length;
    }
  }
  return chars;
}

function estimateMessageChars(
  message: StoredMessageRow,
  truncateResultsAt: number | null,
): number {
  let chars = 0;
  if (typeof message.content === "string") {
    chars += message.content.length;
  }
  if (typeof message.thinking === "string") {
    chars += message.thinking.length;
  }
  chars += estimateToolCallsChars(
    parseToolCalls(message.tool_calls),
    truncateResultsAt,
  );
  return chars;
}

function estimateMessagesChars(
  messages: StoredMessageRow[],
  truncateResultsAt: number | null,
): number {
  return messages.reduce(
    (sum, message) => sum + estimateMessageChars(message, truncateResultsAt),
    0,
  );
}

function buildSummaryText(chat: ChatContextRow): string | null {
  if (!chat.summary_long) return null;

  let topics: string[] = [];
  if (chat.summary_topics) {
    try {
      const parsed = JSON.parse(chat.summary_topics) as unknown;
      topics = Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      topics = [];
    }
  }

  return formatSummaryForLLM({
    tiers: {
      short_term: chat.summary_short ?? "",
      medium_term: chat.summary_medium ?? "",
      long_term: chat.summary_long,
      topics,
      last_updated: chat.summary_last_updated ?? new Date().toISOString(),
    },
    enhanced: deserializeEnhancedFields(chat.summary_enhanced),
    chatFilePath: formatPaprPathForAgent(
      path.join(getPaprRoot(), "Chats", `${chat.id}.txt`),
    ),
  });
}

export interface FootprintComputeOptions {
  /** Pre-aggregated full chat size from SQL (avoids loading all rows). */
  fullChatCharsOverride?: number;
  /** Text-only chars for chats without summary (tool rows loaded separately). */
  textOnlyChars?: number;
  /** Pre-computed agent context size for large chats (SQL estimate). */
  agentContextCharsOverride?: number;
}

export function computeChatTurnFootprint(
  chat: ChatContextRow,
  allMessages: StoredMessageRow[],
  options?: FootprintComputeOptions,
): ChatTurnFootprint {
  const hasSummary = Boolean(chat.summary_long);

  if (
    hasSummary &&
    options?.fullChatCharsOverride !== undefined
  ) {
    const recentMessages = allMessages;
    const recentFullChars = estimateMessagesChars(recentMessages, null);
    const archivedChars = Math.max(
      0,
      options.fullChatCharsOverride - recentFullChars,
    );
    const agentMessagesChars = estimateMessagesChars(
      recentMessages,
      HISTORY_TOOL_RESULT_MAX_CHARS,
    );
    const summaryText = buildSummaryText(chat);
    const summaryChars = summaryText?.length ?? 0;
    const truncationCharsSaved =
      recentFullChars - agentMessagesChars;
    const summaryCharsSaved = Math.max(0, archivedChars - summaryChars);
    const agentContextChars = agentMessagesChars + summaryChars;

    const truncationTokensSaved = charsToTokens(truncationCharsSaved);
    const summaryTokensSaved = charsToTokens(summaryCharsSaved);

    return {
      chatId: chat.id,
      messageCount: chat.message_count,
      hasSummary,
      fullChatTokens: charsToTokens(options.fullChatCharsOverride),
      agentContextTokens: charsToTokens(agentContextChars),
      truncationTokensSaved,
      summaryTokensSaved,
      tokensSavedPerTurn: truncationTokensSaved + summaryTokensSaved,
    };
  }

  if (
    !hasSummary &&
    options?.fullChatCharsOverride !== undefined &&
    options.textOnlyChars !== undefined
  ) {
    if (options.agentContextCharsOverride !== undefined) {
      const truncationCharsSaved = Math.max(
        0,
        options.fullChatCharsOverride - options.agentContextCharsOverride,
      );
      const truncationTokensSaved = charsToTokens(truncationCharsSaved);

      return {
        chatId: chat.id,
        messageCount: chat.message_count,
        hasSummary: false,
        fullChatTokens: charsToTokens(options.fullChatCharsOverride),
        agentContextTokens: charsToTokens(options.agentContextCharsOverride),
        truncationTokensSaved,
        summaryTokensSaved: 0,
        tokensSavedPerTurn: truncationTokensSaved,
      };
    }

    const toolsFullChars = estimateMessagesChars(allMessages, null);
    const toolsTruncatedChars = estimateMessagesChars(
      allMessages,
      HISTORY_TOOL_RESULT_MAX_CHARS,
    );
    const truncationCharsSaved = toolsFullChars - toolsTruncatedChars;
    const agentContextChars = options.textOnlyChars + toolsTruncatedChars;
    const truncationTokensSaved = charsToTokens(truncationCharsSaved);

    return {
      chatId: chat.id,
      messageCount: chat.message_count,
      hasSummary: false,
      fullChatTokens: charsToTokens(options.fullChatCharsOverride),
      agentContextTokens: charsToTokens(agentContextChars),
      truncationTokensSaved,
      summaryTokensSaved: 0,
      tokensSavedPerTurn: truncationTokensSaved,
    };
  }

  const recentLimit = hasSummary
    ? computeRecentMessageLimit(
        chat.message_count,
        chat.summary_base_message_count,
      )
    : allMessages.length;
  const agentMessages = hasSummary
    ? allMessages.slice(-recentLimit)
    : allMessages;
  const archivedMessages = hasSummary
    ? allMessages.slice(0, Math.max(0, allMessages.length - recentLimit))
    : [];

  const fullChatChars = estimateMessagesChars(allMessages, null);
  const agentMessagesChars = estimateMessagesChars(
    agentMessages,
    HISTORY_TOOL_RESULT_MAX_CHARS,
  );
  const summaryText = buildSummaryText(chat);
  const summaryChars = summaryText?.length ?? 0;

  const truncationCharsSaved =
    estimateMessagesChars(agentMessages, null) - agentMessagesChars;
  const summaryCharsSaved = hasSummary
    ? Math.max(
        0,
        estimateMessagesChars(archivedMessages, null) - summaryChars,
      )
    : 0;

  const agentContextChars = agentMessagesChars + summaryChars;
  const truncationTokensSaved = charsToTokens(truncationCharsSaved);
  const summaryTokensSaved = charsToTokens(summaryCharsSaved);

  return {
    chatId: chat.id,
    messageCount: allMessages.length,
    hasSummary,
    fullChatTokens: charsToTokens(fullChatChars),
    agentContextTokens: charsToTokens(agentContextChars),
    truncationTokensSaved,
    summaryTokensSaved,
    tokensSavedPerTurn: truncationTokensSaved + summaryTokensSaved,
  };
}

export interface AggregatedTurnFootprint {
  chatsAnalyzed: number;
  chatsWithSummaries: number;
  fullChatTokensPerTurn: number;
  agentContextTokensPerTurn: number;
  truncationTokensSaved: number;
  summaryTokensSaved: number;
  tokensSavedPerTurn: number;
}

/** Context size if every prior message were sent with full tool results. */
export function estimateNaiveContextChars(
  history: StoredMessageRow[],
): number {
  return estimateMessagesChars(history, null);
}

/** Context size loadMessagesForLLM + historyFormatter would send at this point. */
export function estimateOptimizedContextChars(
  history: StoredMessageRow[],
  chat: ChatContextRow,
): number {
  const hasSummary = Boolean(chat.summary_long);
  if (hasSummary && history.length > 0) {
    const recentLimit = computeRecentMessageLimit(
      chat.message_count,
      chat.summary_base_message_count,
    );
    const recent = history.slice(-recentLimit);
    const summaryText = buildSummaryText(chat);
    const summaryChars = summaryText?.length ?? 0;
    const recentChars = estimateMessagesChars(
      recent,
      HISTORY_TOOL_RESULT_MAX_CHARS,
    );
    return recentChars + summaryChars;
  }
  return estimateMessagesChars(history, HISTORY_TOOL_RESULT_MAX_CHARS);
}

export interface CumulativeChatProjection {
  cumulativeNaiveContextTokens: number;
  cumulativeOptimizedContextTokens: number;
  assistantTurns: number;
  /** Sum of per-turn naive÷optimized ratios (for averaging). */
  perTurnInflationSum: number;
}

/** Sum naive vs optimized context across every assistant turn in one chat. */
export function computeCumulativeChatProjection(
  chat: ChatContextRow,
  messages: MessageWithUsageRow[],
): CumulativeChatProjection {
  let cumulativeNaiveContextTokens = 0;
  let cumulativeOptimizedContextTokens = 0;
  let assistantTurns = 0;
  let perTurnInflationSum = 0;

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "assistant") continue;
    const history = messages.slice(0, i);
    const naiveTokens = charsToTokens(estimateNaiveContextChars(history));
    const optimizedTokens = charsToTokens(
      estimateOptimizedContextChars(history, chat),
    );
    cumulativeNaiveContextTokens += naiveTokens;
    cumulativeOptimizedContextTokens += optimizedTokens;
    if (optimizedTokens > 0) {
      perTurnInflationSum += naiveTokens / optimizedTokens;
    }
    assistantTurns += 1;
  }

  return {
    cumulativeNaiveContextTokens,
    cumulativeOptimizedContextTokens,
    assistantTurns,
    perTurnInflationSum,
  };
}

export interface MessageWithUsageRow extends StoredMessageRow {
  prompt_tokens: number | null;
}

export interface AggregatedCumulativeProjection {
  cumulativeNaiveContextTokens: number;
  cumulativeOptimizedContextTokens: number;
  /** prompt-weighted projection: Σ(prompt_tokens × naive÷optimized per turn) */
  projectedPromptTokens: number;
  measuredPromptTokens: number;
  chatsAnalyzed: number;
  analyzedAssistantTurns: number;
}

export interface SingleTurnFootprint {
  contextNaiveTokens: number;
  contextOptimizedTokens: number;
  hypotheticalPromptTokens: number;
  inflationRatio: number;
}

/** Per-turn naive vs optimized context and hypothetical prompt (actual × inflation). */
export function computeSingleTurnFootprint(
  chat: ChatContextRow,
  history: StoredMessageRow[],
  promptTokens: number,
): SingleTurnFootprint {
  const naiveTokens = charsToTokens(estimateNaiveContextChars(history));
  const optimizedTokens = charsToTokens(
    estimateOptimizedContextChars(history, chat),
  );
  const inflationRatio = capInflationRatio(
    optimizedTokens > 0 ? naiveTokens / optimizedTokens : 1,
  );

  return {
    contextNaiveTokens: naiveTokens,
    contextOptimizedTokens: optimizedTokens,
    hypotheticalPromptTokens: Math.round(promptTokens * inflationRatio),
    inflationRatio,
  };
}

export function computeWeightedPromptProjection(
  chat: ChatContextRow,
  messages: MessageWithUsageRow[],
): {
  projectedPromptTokens: number;
  measuredPromptTokens: number;
  assistantTurns: number;
} {
  let projectedPromptTokens = 0;
  let measuredPromptTokens = 0;
  let assistantTurns = 0;

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "assistant") continue;
    const promptTokens = messages[i].prompt_tokens ?? 0;
    if (promptTokens <= 0) continue;

    const history = messages.slice(0, i);
    const footprint = computeSingleTurnFootprint(chat, history, promptTokens);

    projectedPromptTokens += footprint.hypotheticalPromptTokens;
    measuredPromptTokens += promptTokens;
    assistantTurns += 1;
  }

  return { projectedPromptTokens, measuredPromptTokens, assistantTurns };
}

export function aggregateCumulativeProjections(
  projections: CumulativeChatProjection[],
): AggregatedCumulativeProjection {
  const cumulativeNaiveContextTokens = projections.reduce(
    (sum, p) => sum + p.cumulativeNaiveContextTokens,
    0,
  );
  const cumulativeOptimizedContextTokens = projections.reduce(
    (sum, p) => sum + p.cumulativeOptimizedContextTokens,
    0,
  );
  const analyzedAssistantTurns = projections.reduce(
    (sum, p) => sum + p.assistantTurns,
    0,
  );

  return {
    cumulativeNaiveContextTokens,
    cumulativeOptimizedContextTokens,
    projectedPromptTokens: 0,
    measuredPromptTokens: 0,
    chatsAnalyzed: projections.length,
    analyzedAssistantTurns,
  };
}

export function aggregateWeightedPromptProjections(
  items: Array<{
    projectedPromptTokens: number;
    measuredPromptTokens: number;
    assistantTurns: number;
  }>,
): Pick<
  AggregatedCumulativeProjection,
  "projectedPromptTokens" | "measuredPromptTokens" | "analyzedAssistantTurns"
> {
  return items.reduce(
    (acc, item) => ({
      projectedPromptTokens:
        acc.projectedPromptTokens + item.projectedPromptTokens,
      measuredPromptTokens:
        acc.measuredPromptTokens + item.measuredPromptTokens,
      analyzedAssistantTurns: acc.analyzedAssistantTurns + item.assistantTurns,
    }),
    {
      projectedPromptTokens: 0,
      measuredPromptTokens: 0,
      analyzedAssistantTurns: 0,
    },
  );
}

export function aggregateChatTurnFootprints(
  footprints: ChatTurnFootprint[],
): AggregatedTurnFootprint {
  const chatsWithSummaries = footprints.filter((chat) => chat.hasSummary).length;

  return footprints.reduce(
    (acc, chat) => ({
      chatsAnalyzed: acc.chatsAnalyzed + 1,
      chatsWithSummaries,
      fullChatTokensPerTurn: acc.fullChatTokensPerTurn + chat.fullChatTokens,
      agentContextTokensPerTurn:
        acc.agentContextTokensPerTurn + chat.agentContextTokens,
      truncationTokensSaved:
        acc.truncationTokensSaved + chat.truncationTokensSaved,
      summaryTokensSaved: acc.summaryTokensSaved + chat.summaryTokensSaved,
      tokensSavedPerTurn: acc.tokensSavedPerTurn + chat.tokensSavedPerTurn,
    }),
    {
      chatsAnalyzed: 0,
      chatsWithSummaries,
      fullChatTokensPerTurn: 0,
      agentContextTokensPerTurn: 0,
      truncationTokensSaved: 0,
      summaryTokensSaved: 0,
      tokensSavedPerTurn: 0,
    },
  );
}
