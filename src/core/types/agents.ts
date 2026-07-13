/**
 * Agent configuration and provider types
 */

// Import provider types from AI SDKs (these ARE exported)
import type { AnthropicProvider } from "@ai-sdk/anthropic";
import type { OpenAIProvider } from "@ai-sdk/openai";
import type { GoogleGenerativeAIProvider } from "@ai-sdk/google";

export type Provider = "anthropic" | "openai" | "openai-codex" | "google" | "ollama" | "cursor" | "zai" | "groq";

/** OpenAI AI SDK `providerOptions.openai.reasoningEffort` */
export type OpenAIReasoningEffort = "low" | "medium" | "high" | "xhigh";

/** Model picker reasoning levels (OpenAI + provider-specific e.g. Z.ai "max") */
export type ReasoningEffort = OpenAIReasoningEffort | "max";

export type ModelReasoning = {
  effort?: ReasoningEffort;
};

/**
 * Typed model IDs extracted directly from the AI SDK provider types.
 *
 * The SDKs define e.g. `AnthropicMessagesModelId` internally but don't export it.
 * However, every provider is a callable interface: `provider(modelId)`.
 * `Parameters<AnthropicProvider>[0]` pulls the first argument type from that
 * call signature, which IS the model ID union — no manual maintenance needed.
 *
 * These types stay in sync automatically whenever the SDK packages are updated.
 */
export type AnthropicModel = Parameters<AnthropicProvider>[0];
export type OpenAIModel = Parameters<OpenAIProvider>[0];
export type GoogleModel = Parameters<GoogleGenerativeAIProvider>[0];

/**
 * Union of all valid model IDs across providers.
 * Each SDK type includes a (string & {}) escape hatch so any string is still
 * accepted at runtime — but known IDs get full autocomplete and validation.
 */
export type ModelId = AnthropicModel | OpenAIModel | GoogleModel;

/**
 * Agent configuration (public interface)
 *
 * Note: apiKey is NOT included here - Gateway fetches it internally via IPC
 * This keeps keys secure and never sends them over WebSocket
 */
export interface AgentConfig {
  provider: Provider;
  model: ModelId; // ✅ Now typed! Provides autocomplete and catches obvious typos
  systemPrompt: string;
  maxSteps?: number;
  maxTokens?: number; // Output token limit
  thinkingBudget?: number;
  reasoning?: ModelReasoning;
}

/**
 * Internal agent configuration with API key
 * Used only within Gateway after fetching key via IPC
 */
export interface AgentConfigInternal extends AgentConfig {
  /** Route through Papr AI proxy (memory.papr.ai/v1/ai/) when user has no provider keys */
  usePaprProxy?: boolean;
  apiKey: string; // Fetched internally via IPC, never sent over network
  /** When OAuth is used for openai/anthropic; used to route to pi-ai vs AI SDK */
  authType?: "oauth" | "apiKey";
}

/**
 * Provider configuration for settings
 */
export interface ProviderConfig {
  apiKey: string;
  models: string[];
  defaultModel?: string;
}

/**
 * All provider configurations
 */
export interface ProvidersConfig {
  anthropic?: ProviderConfig;
  openai?: ProviderConfig;
  google?: ProviderConfig;
}

/**
 * Model information
 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: Provider;
  contextWindow: number;
  supportsThinking: boolean;
  supportsVision: boolean;
}

/**
 * Session state for active chats
 */
export interface SessionState {
  chatId: string;
  provider: Provider;
  model: string;
  isStreaming: boolean;
  lastMessageAt: string;
}
