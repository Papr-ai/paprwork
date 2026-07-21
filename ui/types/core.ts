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
  status: "calling" | "success" | "error" | "interrupted";
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

// Agent types — re-export shared types from core (single source of truth)
export type {
  Provider,
  ReasoningEffort,
  ModelReasoning,
} from "../../src/core/types/agents";

import type { AgentConfig as CoreAgentConfig } from "../../src/core/types/agents";

/** UI agent config (model id is string — picker ids include Groq slashes) */
export interface AgentConfig extends Omit<CoreAgentConfig, "model"> {
  model: string;
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
