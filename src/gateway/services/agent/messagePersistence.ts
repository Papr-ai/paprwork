import { v4 as uuidv4 } from "uuid";
import type { StoredMessage } from "../storage/IStorageProvider.js";
import type { ToolCallEvent, ToolResultEvent } from "./streamChunks.js";

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

export function createAssistantStoredMessage(args: {
  chatId: string;
  model: string;
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallEvent[];
  toolResults: ToolResultEvent[];
  sequence?: Array<{ type: "text" | "tool" | "thinking"; data: any }>; // V1-style sequence
}): StoredMessage {
  return {
    id: `msg-${uuidv4()}`,
    chat_id: args.chatId,
    role: "assistant",
    content: args.assistantText,
    thinking: args.thinkingText || undefined,
    toolCalls:
      args.toolCalls.length > 0
        ? args.toolCalls.map((toolCall) => ({
            id: toolCall.toolCallId,
            name: toolCall.toolName,
            args: toolCall.args,
            result: formatToolResultForStorage(
              args.toolResults.find(
                (toolResult) => toolResult.toolCallId === toolCall.toolCallId,
              )?.result,
            ),
            status: "success" as const,
          }))
        : undefined,
    sequence: args.sequence, // Include V1-style sequence for interleaving
    timestamp: new Date().toISOString(),
    model: args.model,
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
}): StoredMessage {
  return {
    id: `msg-${uuidv4()}`,
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
        ? args.toolCalls.map((toolCall) => ({
            id: toolCall.toolCallId,
            name: toolCall.toolName,
            args: toolCall.args,
            result: formatToolResultForStorage(
              args.toolResults.find(
                (toolResult) => toolResult.toolCallId === toolCall.toolCallId,
              )?.result,
            ),
            status: "error" as const,
          }))
        : undefined,
    error: args.errorMessage,
    incomplete: true,
    timestamp: new Date().toISOString(),
    model: args.model,
    sync_status: "local",
  };
}
