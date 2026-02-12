/**
 * Core types - UI-safe re-exports
 * This file only imports types (no runtime code) to avoid bundling Node.js dependencies
 */

// Message types
export type MessageRole = "system" | "user" | "assistant";

export interface ToolCall {
  id: string;
  toolName: string;
  args?: Record<string, unknown>;
  status: "calling" | "success" | "error";
  result?: string;
  error?: string;
}

export interface CoreMessage {
  role: MessageRole;
  content: string;

  // Reasoning/thinking content
  reasoning?: string;
  streamingReasoning?: string;

  // Tool calls
  toolCalls?: ToolCall[];
}

// Agent types
export type Provider = "anthropic" | "openai" | "google";

/**
 * Agent configuration (public interface)
 * Note: apiKey is NOT included - Gateway fetches it via IPC
 */
export interface AgentConfig {
  provider: Provider;
  model: string;
  systemPrompt: string;
  maxSteps?: number;
  thinkingBudget?: number;
  reasoning?: {
    effort?: "low" | "medium" | "high" | "xhigh";
  };
}

// Streaming types
export type StreamChunkType =
  | "text-delta"
  | "reasoning-delta"
  | "tool-call"
  | "tool-call-delta"
  | "tool-result"
  | "tool-error"
  | "error"
  | "done";

export interface StreamChunk<T = unknown> {
  type: StreamChunkType;
  payload: T;
  timestamp: string;
}

export interface TextDeltaPayload {
  text: string;
}

export interface ErrorPayload {
  error: string;
  code?: string;
  details?: unknown;
}
