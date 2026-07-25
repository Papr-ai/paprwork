import { v4 as uuidv4 } from "uuid";
import { resolveToolCallStatus } from "../../../core/utils/interruptedToolResult.js";
import type { StoredMessage } from "../storage/IStorageProvider.js";
import type { ToolCallEvent, ToolResultEvent } from "./streamChunks.js";
import { calculateCostWithCache, type TokenUsageForCost } from "../CostCalculation.js";

function getPersistedToolCallStatus(
  toolCallId: string,
  toolResults: ToolResultEvent[],
): "success" | "error" | "interrupted" {
  const matchedResult = toolResults.find(
    (toolResult) => toolResult.toolCallId === toolCallId,
  )?.result;
  const status = resolveToolCallStatus({ result: matchedResult });

  if (status === "interrupted") return "interrupted";
  if (status === "error") return "error";
  return "success";
}

export function formatToolResultForStorage(
  result: unknown,
): string | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  if (typeof result === "string") {
    return result;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function hasPersistableAssistantContent(args: {
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallEvent[];
  sequence?: Array<{ type: string; data: unknown }>;
}): boolean {
  return (
    args.assistantText.trim().length > 0 ||
    args.thinkingText.trim().length > 0 ||
    args.toolCalls.length > 0 ||
    (args.sequence?.length ?? 0) > 0
  );
}

export function createPartialAssistantStoredMessage(args: {
  chatId: string;
  model: string;
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallEvent[];
  toolResults: ToolResultEvent[];
  sequence?: Array<{ type: "text" | "tool" | "thinking"; data: any }>;
  usage?: TokenUsageForCost & { totalTokens?: number };
  /** Optional pre-generated stable ID for checkpoint persistence */
  stableId?: string;
}): StoredMessage {
  return {
    ...createAssistantStoredMessage(args),
    incomplete: true,
  };
}

export function createAssistantStoredMessage(args: {
  chatId: string;
  model: string;
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallEvent[];
  toolResults: ToolResultEvent[];
  sequence?: Array<{ type: "text" | "tool" | "thinking"; data: any }>; // V1-style sequence
  usage?: TokenUsageForCost & { totalTokens?: number };
  /** Optional pre-generated stable ID for checkpoint persistence */
  stableId?: string;
}): StoredMessage {
  const cost = args.usage
    ? calculateCostWithCache(args.model, {
        promptTokens: args.usage.promptTokens,
        completionTokens: args.usage.completionTokens,
        cacheReadTokens: args.usage.cacheReadTokens,
        cacheWriteTokens: args.usage.cacheWriteTokens,
      })
    : undefined;

  return {
    id: args.stableId ?? `msg-${uuidv4()}`,
    chat_id: args.chatId,
    role: "assistant",
    content: args.assistantText,
    thinking: args.thinkingText || undefined,
    toolCalls:
      args.toolCalls.length > 0
        ? args.toolCalls.map((toolCall) => {
            // Debug: Log what we're saving
            console.log(`[MessagePersistence] Saving tool call:`, {
              id: toolCall.toolCallId,
              name: toolCall.toolName,
              hasArgs: !!toolCall.args,
              argsKeys: toolCall.args ? Object.keys(toolCall.args) : [],
            });
            
            return {
              id: toolCall.toolCallId,
              name: toolCall.toolName,
              args: toolCall.args,
              result: formatToolResultForStorage(
                args.toolResults.find(
                  (toolResult) => toolResult.toolCallId === toolCall.toolCallId,
                )?.result,
              ),
              status: getPersistedToolCallStatus(
                toolCall.toolCallId,
                args.toolResults,
              ),
            };
          })
        : undefined,
    sequence: args.sequence, // Include V1-style sequence for interleaving
    timestamp: new Date().toISOString(),
    model: args.model,
    prompt_tokens: args.usage?.promptTokens,
    completion_tokens: args.usage?.completionTokens,
    total_tokens: args.usage?.totalTokens,
    cache_read_tokens: args.usage?.cacheReadTokens,
    cache_write_tokens: args.usage?.cacheWriteTokens,
    cost,
    sync_status: "local",
  };
}

function createErrorContent(args: {
  assistantText: string;
  toolCallsCount: number;
  errorMessage: string;
}): string {
  let errorContent = args.assistantText;
  if (!errorContent && args.toolCallsCount > 0) {
    errorContent = `⚠️ Response interrupted after ${args.toolCallsCount} tool call(s)`;
  }
  if (!errorContent) {
    errorContent = "❌ An error occurred while generating the response";
  }

  return `${errorContent}\n\n---\n❌ **Error**: ${args.errorMessage}`;
}

export function createErrorStoredMessage(args: {
  chatId: string;
  model: string;
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallEvent[];
  toolResults: ToolResultEvent[];
  errorMessage: string;
  sequence?: Array<{ type: "text" | "tool" | "thinking"; data: any }>;
  usage?: TokenUsageForCost & { totalTokens?: number };
  /** Optional pre-generated stable ID for checkpoint persistence */
  stableId?: string;
}): StoredMessage {
  const cost = args.usage
    ? calculateCostWithCache(args.model, {
        promptTokens: args.usage.promptTokens,
        completionTokens: args.usage.completionTokens,
        cacheReadTokens: args.usage.cacheReadTokens,
        cacheWriteTokens: args.usage.cacheWriteTokens,
      })
    : undefined;

  return {
    id: args.stableId ?? `msg-${uuidv4()}`,
    chat_id: args.chatId,
    role: "assistant",
    content: createErrorContent({
      assistantText: args.assistantText,
      toolCallsCount: args.toolCalls.length,
      errorMessage: args.errorMessage,
    }),
    thinking: args.thinkingText || undefined,
    toolCalls:
      args.toolCalls.length > 0
        ? args.toolCalls.map((toolCall) => {
            const matchedResult = args.toolResults.find(
              (toolResult) => toolResult.toolCallId === toolCall.toolCallId,
            )?.result;
            const status = resolveToolCallStatus({ result: matchedResult });

            return {
              id: toolCall.toolCallId,
              name: toolCall.toolName,
              args: toolCall.args,
              result: formatToolResultForStorage(matchedResult),
              status: status === "interrupted" ? "interrupted" : "error",
            };
          })
        : undefined,
    sequence: args.sequence,
    error: args.errorMessage,
    incomplete: true,
    timestamp: new Date().toISOString(),
    model: args.model,
    prompt_tokens: args.usage?.promptTokens,
    completion_tokens: args.usage?.completionTokens,
    total_tokens: args.usage?.totalTokens,
    cache_read_tokens: args.usage?.cacheReadTokens,
    cache_write_tokens: args.usage?.cacheWriteTokens,
    cost,
    sync_status: "local",
  };
}
