/**
 * Chat Session Manager
 *
 * Manages parallel chat sessions for concurrent streaming.
 * Each chat gets its own Mastra agent instance and abort controller.
 * Based on Paprwork V1's chatSessions architecture.
 */

import { Agent } from "@mastra/core/agent";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import type { AgentConfigInternal } from "../../core/types/agents.js";
import { createProxyModel } from "../utils/paprProxyProvider.js";
import type { StorageManager } from "./StorageManager.js";
import {
  normalizeOpenAIModelId,
  normalizeGoogleModelId,
} from "../utils/modelNormalizer.js";

export interface ChatSession {
  chatId: string;
  agent: Agent;
  abortController: AbortController | null;
  config: AgentConfigInternal;
  isStreaming: boolean;
  createdAt: string;
}

export class ChatSessionManager {
  private sessions: Map<string, ChatSession> = new Map();

  constructor(_storageManager: StorageManager) {
    // storageManager not used but kept for future use
  }

  /**
   * Get or create a chat session
   * Each chat gets its own agent instance for parallel streaming
   */
  async getSession(
    chatId: string,
    config: AgentConfigInternal,
  ): Promise<ChatSession> {
    // Return existing session if same config
    if (this.sessions.has(chatId)) {
      const session = this.sessions.get(chatId)!;

      // Check if config changed (model or provider)
      if (this.isSameConfig(session.config, config)) {
        return session;
      }

      // Config changed, recreate session
      await this.clearSession(chatId);
    }

    // Create new session
    const agent = await this.createAgent(config);

    const session: ChatSession = {
      chatId,
      agent,
      abortController: null,
      config,
      isStreaming: false,
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(chatId, session);
    console.log(
      `✓ Created chat session for ${chatId} with ${config.provider}/${config.model}`,
    );

    return session;
  }

  /**
   * Create a Mastra agent with the specified config
   */
  private async createAgent(config: AgentConfigInternal): Promise<Agent> {
    // Set API keys in environment for AI SDK providers
    if (config.provider === "anthropic") {
      process.env.ANTHROPIC_API_KEY = config.apiKey;
      console.log(
        `[ChatSessionManager] Set ANTHROPIC_API_KEY in env (authType=${config.authType}, length=${config.apiKey?.length || 0})`,
      );
    } else if (
      config.provider === "openai" ||
      config.provider === "openai-codex"
    ) {
      process.env.OPENAI_API_KEY = config.apiKey;
      console.log(
        `[ChatSessionManager] Set OPENAI_API_KEY in env (provider=${config.provider}, authType=${config.authType}, length=${config.apiKey?.length || 0})`,
      );
    } else if (config.provider === "google") {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.apiKey;
      console.log(
        `[ChatSessionManager] Set GOOGLE_GENERATIVE_AI_API_KEY in env (authType=${config.authType}, length=${config.apiKey?.length || 0})`,
      );
    } else if (config.provider === "ollama") {
      console.log(
        `[ChatSessionManager] Ollama provider - no API key needed (local inference)`,
      );
    }

    // Select the appropriate AI SDK provider
    let model;

    // Route through Papr AI proxy if configured (user logged in via Papr, no direct API key)
    if (config.usePaprProxy && config.apiKey) {
      console.log(
        `[ChatSessionManager] Using Papr AI proxy for ${config.provider}/${config.model}`,
      );
      model = await createProxyModel(config.provider, config.model, config.apiKey) as any;
    } else switch (config.provider) {
      case "anthropic":
        model = anthropic(config.model);
        break;

      case "openai":
        // Normalize model ID: accept gpt-5.x with dots or dashes (e.g. gpt-5-4-low)
        // API expects canonical ids (e.g. gpt-5.4); reasoning effort comes from config.reasoning via providerOptions
        const normalizedModel = normalizeOpenAIModelId(config.model);

        // Use Responses API for GPT-5 reasoning models (enables reasoning token streaming)
        if (normalizedModel.startsWith("gpt-5")) {
          model = openai.responses(normalizedModel);
        } else {
          model = openai(normalizedModel);
        }
        break;

      case "openai-codex":
        // OpenAI Codex uses OAuth token (already set in OPENAI_API_KEY above)
        // Use Responses API for Codex models (gpt-5.3-codex)
        model = openai.responses(config.model);
        break;

      case "google":
        model = google(normalizeGoogleModelId(config.model));
        break;

      case "ollama": {
        // Ollama runs locally, no API key needed
        const { ollama: ollamaProvider } = await import("ollama-ai-provider-v2");
        model = ollamaProvider(config.model);
        break;
      }

      default:
        throw new Error(`Unsupported provider: ${config.provider}`);
    }

    // Create Mastra agent
    const agent = new Agent({
      id: `agent-${Date.now()}`,
      name: "paprwork-agent",
      instructions: config.systemPrompt || this.getDefaultSystemPrompt(),
      model,
    });

    return agent;
  }

  /**
   * Get default system prompt
   */
  private getDefaultSystemPrompt(): string {
    return `You are a helpful AI assistant. You provide clear, accurate, and thoughtful responses.`;
  }

  /**
   * Check if two configs are the same
   */
  private isSameConfig(
    config1: AgentConfigInternal,
    config2: AgentConfigInternal,
  ): boolean {
    return (
      config1.provider === config2.provider &&
      config1.model === config2.model &&
      config1.apiKey === config2.apiKey &&
      config1.authType === config2.authType
    );
  }

  /**
   * Abort streaming for a specific chat
   */
  async abortSession(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);

    if (!session) {
      console.warn(`No session found for chat ${chatId}`);
      return;
    }

    if (session.abortController) {
      session.abortController.abort();
      session.abortController = null;
      session.isStreaming = false;
      console.log(`✓ Aborted streaming for chat ${chatId}`);
    }
  }

  /**
   * Get session if it exists (for inspection/debugging)
   * Returns null if session doesn't exist
   */
  getSessionIfExists(chatId: string): ChatSession | null {
    return this.sessions.get(chatId) || null;
  }

  /**
   * Clear a session (remove from memory)
   */
  async clearSession(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);

    if (session) {
      // Abort any active streaming
      if (session.abortController) {
        session.abortController.abort();
      }

      this.sessions.delete(chatId);
      console.log(`✓ Cleared session for chat ${chatId}`);
    }
  }

  /**
   * Get all active sessions
   */
  getAllActiveSessions(): ChatSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get all streaming sessions
   */
  getStreamingSessions(): ChatSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.isStreaming);
  }

  /**
   * Check if a chat is currently streaming
   */
  isStreaming(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    return session?.isStreaming || false;
  }

  /**
   * Mark session as streaming
   */
  setStreaming(chatId: string, isStreaming: boolean): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.isStreaming = isStreaming;
    }
  }

  /**
   * Set abort controller for a session
   */
  setAbortController(chatId: string, controller: AbortController | null): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.abortController = controller;
    }
  }

  /**
   * Clear all sessions (e.g., on app shutdown)
   */
  async clearAllSessions(): Promise<void> {
    for (const chatId of this.sessions.keys()) {
      await this.abortSession(chatId);
    }
    this.sessions.clear();
    console.log("✓ Cleared all chat sessions");
  }

  /**
   * Get session count for monitoring
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
