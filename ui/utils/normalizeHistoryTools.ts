import { resolveToolCallStatus } from "../../src/core/utils/interruptedToolResult";
import type { ChatMessage, SequenceItem } from "../types/chat";

function sequenceToolHasResult(data: Record<string, unknown>): boolean {
  const output = data.output;
  const result = data.result;
  if (output !== undefined && output !== null && String(output).length > 0) {
    return true;
  }
  if (result !== undefined && result !== null && String(result).length > 0) {
    return true;
  }
  return false;
}

function normalizeSequenceItem(item: SequenceItem): SequenceItem {
  if (item.type !== "tool") return item;
  if (typeof item.data !== "object" || item.data === null) return item;

  const data = { ...(item.data as Record<string, unknown>) };
  const explicitStatus =
    typeof data.status === "string" ? data.status : undefined;

  if (explicitStatus === "calling") {
    data.status = sequenceToolHasResult(data) ? "success" : "interrupted";
    return { ...item, data };
  }

  if (!explicitStatus && sequenceToolHasResult(data)) {
    data.status = "success";
    return { ...item, data };
  }

  return item;
}

/**
 * Completed turns loaded from history should never keep tools stuck in "calling".
 */
export function normalizeLoadedMessage(message: ChatMessage): ChatMessage {
  if (message.isStreaming) return message;

  let next = message;

  if (message.sequence?.length) {
    const sequence = message.sequence.map(normalizeSequenceItem);
    next = { ...next, sequence };
  }

  if (message.toolCalls?.length) {
    const toolCalls = message.toolCalls.map((toolCall) => ({
      ...toolCall,
      status: resolveToolCallStatus({
        explicitStatus: toolCall.status,
        result: toolCall.result,
      }),
    }));
    next = { ...next, toolCalls };
  }

  return next;
}

export function normalizeLoadedMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(normalizeLoadedMessage);
}
