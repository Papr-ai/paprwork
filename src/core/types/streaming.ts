/**
 * Streaming types for real-time responses
 */

/**
 * Stream chunk types
 */
export type StreamChunkType =
  | "text-delta"
  | "reasoning-delta"
  | "tool-call"
  | "tool-call-delta"
  | "tool-result"
  | "tool-error"
  | "step-usage" // Token usage from intermediate steps (not final)
  | "compression-start" // Context overflow — summarization in progress
  | "compression-complete" // Summarization finished, stream will retry
  | "wrap-up-start" // Post-tool text summary in progress
  | "concurrency-queued" // Waiting for an agent stream slot
  | "concurrency-acquired" // Slot acquired — model work starting
  | "error"
  | "done";

/**
 * Generic stream chunk
 */
export interface StreamChunk<T = unknown> {
  type: StreamChunkType;
  payload: T;
  timestamp: string;
}

/**
 * Text delta payload
 */
export interface TextDeltaPayload {
  text: string;
}

/**
 * Reasoning delta payload (thinking)
 */
export interface ReasoningDeltaPayload {
  text: string;
}

/**
 * Tool call payload
 */
export interface ToolCallPayload {
  toolName: string;
  toolCallId?: string;
  args: Record<string, unknown>;
}

/**
 * Tool call delta payload (for streaming tool calls)
 */
export interface ToolCallDeltaPayload {
  toolCallId: string;
  argsChunk: string;
}

/**
 * Tool result payload
 */
export interface ToolResultPayload {
  toolName: string;
  toolCallId?: string;
  result: unknown;
  success: boolean;
  duration?: number;
}

/**
 * Tool error payload
 */
export interface ToolErrorPayload {
  toolName: string;
  toolCallId?: string;
  error: string;
}

/**
 * Error payload
 */
export interface ErrorPayload {
  error: string;
  code?: string;
  details?: unknown;
}

/**
 * Done payload
 */
export interface DonePayload {
  success: boolean;
  totalDuration?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
}

/**
 * Emitted while waiting for a concurrency pool slot (no model work yet).
 */
export interface ConcurrencyQueuePayload {
  pool: "chat" | "job";
  activeCount: number;
  maxConcurrent: number;
  waitingCount: number;
}

/**
 * Streaming callbacks
 */
export interface StreamingCallbacks {
  onText?: (text: string) => void;
  onTextDelta?: (payload: TextDeltaPayload) => void;
  onThinking?: (thinking: string) => void;
  onToolCall?: (toolCall: ToolCallPayload) => void;
  onToolResult?: (result: ToolResultPayload) => void;
  onDone?: (payload: DonePayload) => void;
  onError?: (payload: ErrorPayload) => void;
  onTokenUsage?: (usage: {
    input: number;
    output: number;
    total: number;
  }) => void;
}
