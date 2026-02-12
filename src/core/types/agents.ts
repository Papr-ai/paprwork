/**
 * Agent configuration and provider types
 */

export type Provider = "anthropic" | "openai" | "google";

/**
 * Agent configuration (public interface)
 * 
 * Note: apiKey is NOT included here - Gateway fetches it internally via IPC
 * This keeps keys secure and never sends them over WebSocket
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

/**
 * Internal agent configuration with API key
 * Used only within Gateway after fetching key via IPC
 */
export interface AgentConfigInternal extends AgentConfig {
  apiKey: string; // Fetched internally via IPC, never sent over network
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
