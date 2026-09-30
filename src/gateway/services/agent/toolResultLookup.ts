import type { StoredMessage } from "../storage/IStorageProvider.js";
import { getInFlightToolResult } from "./inFlightToolResults.js";

interface ToolCallItem {
  id?: string;
  toolCallId?: string;
  name?: string;
  toolName?: string;
  result?: string | unknown;
  /** Present when `result` is only a preview and the full text lives on disk. */
  resultOffload?: { file: string; totalChars: number };
}

interface SequenceToolItem {
  type?: string;
  data?: {
    toolCallId?: string;
    name?: string;
    output?: unknown;
  };
}

function normalizeToolCallId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.length > 64 ? sanitized.substring(0, 64) : sanitized;
}

function toolCallIdsMatch(storedId: string, requestedId: string): boolean {
  if (storedId === requestedId) {
    return true;
  }
  return normalizeToolCallId(storedId) === normalizeToolCallId(requestedId);
}

function formatStoredResult(result: string | unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result === undefined || result === null) {
    return "";
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function matchesToolCall(
  tc: ToolCallItem,
  toolCallId: string,
  toolName?: string,
): boolean {
  const storedId = tc.id ?? tc.toolCallId;
  if (!storedId || !toolCallIdsMatch(storedId, toolCallId)) {
    return false;
  }
  const storedName = tc.name ?? tc.toolName;
  return !toolName || storedName === toolName;
}

function findInMessageToolCalls(
  message: StoredMessage,
  toolCallId: string,
  toolName?: string,
): { toolName: string; result: string; isOffloaded?: boolean } | null {
  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      if (!matchesToolCall(tc as ToolCallItem, toolCallId, toolName)) {
        continue;
      }
      const item = tc as ToolCallItem;
      return {
        toolName: item.name ?? item.toolName ?? toolName ?? "unknown",
        result: formatStoredResult(item.result),
        // The row only holds a preview; the caller reads the sidecar for the
        // full text, which is the whole point of this tool.
        ...(item.resultOffload ? { isOffloaded: true } : {}),
      };
    }
  }

  const sequence = message.sequence as SequenceToolItem[] | undefined;
  if (sequence) {
    for (const item of sequence) {
      if (item.type !== "tool") {
        continue;
      }
      const data = item.data;
      const storedId = data?.toolCallId;
      if (!storedId || !toolCallIdsMatch(storedId, toolCallId)) {
        continue;
      }
      const storedName = data?.name;
      if (toolName && storedName && storedName !== toolName) {
        continue;
      }
      return {
        toolName: storedName ?? toolName ?? "unknown",
        result: formatStoredResult(data?.output),
      };
    }
  }

  return null;
}

interface FindFullToolResultArgs {
  chatIds: string[];
  toolCallId: string;
  toolName?: string;
  loadMessages: (chatId: string) => Promise<StoredMessage[]>;
  /**
   * Reads a result that was moved out of the row into sidecar storage.
   * Omit it and the caller gets the inline preview instead.
   */
  readOffloaded?: (
    chatId: string,
    messageId: string,
    toolCallId: string,
  ) => Promise<string | null>;
}

export function findFullToolResult(args: FindFullToolResultArgs): Promise<{
  toolName: string;
  result: string;
  messageId: string;
  chatId: string;
} | null> {
  return findFullToolResultImpl(args);
}

async function findFullToolResultImpl(
  args: FindFullToolResultArgs,
): Promise<{
  toolName: string;
  result: string;
  messageId: string;
  chatId: string;
} | null> {
  for (const chatId of args.chatIds) {
    const inFlight = getInFlightToolResult(chatId, args.toolCallId);
    if (inFlight) {
      if (args.toolName && inFlight.toolName !== args.toolName) {
        continue;
      }
      return {
        toolName: inFlight.toolName,
        result: inFlight.result,
        messageId: "in-flight",
        chatId,
      };
    }
  }

  for (const chatId of args.chatIds) {
    const messages = await args.loadMessages(chatId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const match = findInMessageToolCalls(message, args.toolCallId, args.toolName);
      if (!match) {
        continue;
      }

      const { isOffloaded, ...found } = match;
      if (isOffloaded && args.readOffloaded) {
        const full = await args.readOffloaded(
          chatId,
          message.id,
          args.toolCallId,
        );
        if (full !== null) {
          found.result = full;
        }
      }

      return {
        ...found,
        messageId: message.id,
        chatId,
      };
    }
  }

  return null;
}

export function sliceToolResult(
  resultStr: string,
  startChar?: number,
  length?: number,
): {
  result: string;
  startChar: number;
  endChar: number;
  lengthReturned: number;
  hasMore: boolean;
  nextStartChar?: number;
} {
  if (startChar === undefined) {
    return {
      result: resultStr,
      startChar: 0,
      endChar: resultStr.length,
      lengthReturned: resultStr.length,
      hasMore: false,
    };
  }

  const start = startChar;
  const end = length ? start + length : undefined;
  const sliced = resultStr.substring(start, end);
  const endChar = end ?? resultStr.length;

  return {
    result: sliced,
    startChar: start,
    endChar,
    lengthReturned: sliced.length,
    hasMore: end !== undefined && end < resultStr.length,
    nextStartChar: end !== undefined && end < resultStr.length ? end : undefined,
  };
}
