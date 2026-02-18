import type {
  ErrorPayload,
  StreamChunk,
  StreamChunkType,
  TextDeltaPayload,
  ReasoningDeltaPayload,
  ToolCallPayload,
  ToolResultPayload,
  ToolErrorPayload,
} from "../../../core/types/streaming.js";
import { truncateResult } from "../../../core/tools/index.js";

type ChatStreamChunkPayload =
  | TextDeltaPayload
  | ReasoningDeltaPayload
  | ToolCallPayload
  | ToolResultPayload
  | ToolErrorPayload
  | ErrorPayload;

export type ChatStreamChunk = StreamChunk<ChatStreamChunkPayload> & {
  chatId: string;
};

export interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  toolCallId: string;
  toolName: string;
  result: unknown;
}

export interface ToolErrorEvent {
  toolCallId?: string;
  toolName?: string;
  error: unknown;
}

export function createChatStreamChunk(
  type: StreamChunkType,
  payload: ChatStreamChunkPayload,
  chatId: string,
): ChatStreamChunk {
  return {
    type,
    payload,
    chatId,
    timestamp: new Date().toISOString(),
  };
}

function getRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input === "object" && input !== null) {
    return input as Record<string, unknown>;
  }
  return null;
}

export function parseToolCallChunk(chunk: unknown): ToolCallEvent | null {
  const record = getRecord(chunk);
  if (!record) return null;

  const toolCallId = record.toolCallId;
  const toolName = record.toolName;
  const input = record.input;
  const args = record.args;

  if (typeof toolCallId !== "string" || typeof toolName !== "string") {
    return null;
  }

  const parsedArgs =
    getRecord(input) ??
    getRecord(args) ?? {
      value: input ?? args ?? {},
    };

  return {
    toolCallId,
    toolName,
    args: parsedArgs,
  };
}

export function parseToolResultChunk(chunk: unknown): ToolResultEvent | null {
  const record = getRecord(chunk);
  if (!record) return null;

  const toolCallId = record.toolCallId;
  const toolName = record.toolName;
  const output = record.output;
  const result = record.result;

  if (typeof toolCallId !== "string" || typeof toolName !== "string") {
    return null;
  }

  return {
    toolCallId,
    toolName,
    result: output ?? result ?? null,
  };
}

/**
 * Extract a human-readable error message from whatever the AI SDK puts in a
 * tool-error chunk.  Error objects don't survive JSON serialisation (they
 * become {}) so we must extract .message while the value is still live.
 */
function extractErrorMessage(raw: unknown): string {
  // Live Error object (most common case — tool threw before JSON round-trip)
  if (raw instanceof Error) {
    return raw.message || raw.toString();
  }
  // Plain object with a message string (some SDK wrappers do this)
  if (typeof raw === "object" && raw !== null) {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.message === "string" && rec.message.length > 0) {
      return rec.message;
    }
    // {} — Error was already serialised to JSON and lost its message
    if (Object.keys(rec).length === 0) {
      return "Tool execution failed (error details were lost during serialisation — check gateway logs for the actual exception)";
    }
    // Some other shape — give the agent something to work with
    try {
      return JSON.stringify(rec);
    } catch {
      return "[unserializable error object]";
    }
  }
  if (typeof raw === "string" && raw.length > 0) return raw;
  return "Tool execution failed (unknown error)";
}

export function parseToolErrorChunk(chunk: unknown): ToolErrorEvent | null {
  const record = getRecord(chunk);
  if (!record) return null;

  const toolCallId = record.toolCallId;
  const toolName = record.toolName;

  if (toolCallId !== undefined && typeof toolCallId !== "string") {
    return null;
  }
  if (toolName !== undefined && typeof toolName !== "string") {
    return null;
  }

  // Prefer record.error; fall back to the whole chunk as the error source
  const rawError = record.error !== undefined ? record.error : chunk;
  const error = extractErrorMessage(rawError);

  return {
    toolCallId: typeof toolCallId === "string" ? toolCallId : undefined,
    toolName: typeof toolName === "string" ? toolName : undefined,
    error,
  };
}

export function truncateStringsInUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateResult(value);
  }

  if (Array.isArray(value)) {
    return value.map(truncateStringsInUnknown);
  }

  const record = getRecord(value);
  if (!record) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(record)) {
    next[key] = truncateStringsInUnknown(nestedValue);
  }
  return next;
}
