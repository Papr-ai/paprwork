/**
 * Mastra agent wrapper - Main agent class using Mastra framework
 * Handles streaming, tool calling, and session management
 */

import { Agent } from "@mastra/core/agent";
import type {
  AgentConfigInternal,
  CoreMessage,
  StreamChunk,
  StreamingCallbacks,
} from "../types/index.js";
import { SessionManager } from "./SessionManager.js";

/**
 * Mastra chunk types from their streaming API
 * Based on @mastra/core/dist/stream/types.d.ts
 */
interface MastraChunk {
  type: string;
  runId: string;
  from: string;
  payload: Record<string, unknown>;
}

interface MastraTextDeltaPayload {
  id: string;
  text: string;
  providerMetadata?: Record<string, unknown>;
}

interface MastraReasoningDeltaPayload {
  id: string;
  text: string;
  providerMetadata?: Record<string, unknown>;
}

interface MastraToolCallPayload {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}

export class MastraAgent {
  private sessionManager: SessionManager;

  constructor(userDataPath: string) {
    this.sessionManager = new SessionManager(userDataPath);
  }

  /**
   * Initialize agent (must be called before use)
   */
  async initialize(): Promise<void> {
    await this.sessionManager.initialize();
  }

  /**
   * Stream agent response with tool calling
   */
  async *stream(
    chatId: string,
    userMessage: string,
    config: AgentConfigInternal,
    callbacks?: StreamingCallbacks,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    try {
      // Load session history
      const messages = await this.sessionManager.loadSession(chatId);

      // Add user message
      const userMsg: CoreMessage = { role: "user", content: userMessage };
      messages.push(userMsg);

      // Save user message
      await this.sessionManager.saveMessage(chatId, userMsg);

      // Set API key in environment for Mastra
      // Mastra expects provider-specific env vars
      // Anthropic: ANTHROPIC_API_KEY
      // OpenAI: OPENAI_API_KEY
      // Google: GOOGLE_GENERATIVE_AI_API_KEY
      let envKeyName: string;
      if (config.provider === "google") {
        envKeyName = "GOOGLE_GENERATIVE_AI_API_KEY";
      } else {
        envKeyName = `${config.provider.toUpperCase()}_API_KEY`;
      }
      const originalKey = process.env[envKeyName];
      if (config.apiKey) {
        process.env[envKeyName] = config.apiKey;
      }

      try {
        // Map UI model ID to API model ID
        // All GPT-5-2 variants (except codex) use the same API ID "gpt-5-2"
        let apiModelId = config.model;
        if (
          config.model.startsWith("gpt-5-2-") &&
          config.model !== "gpt-5-2-codex"
        ) {
          apiModelId = "gpt-5-2"; // Map gpt-5-2-low, gpt-5-2-high, gpt-5-2-xhigh to gpt-5-2
        }

        // Create Mastra agent with tools passed as object
        const agent = new Agent({
          id: `chat-${chatId}`,
          name: "Paprwork Assistant",
          instructions:
            config.systemPrompt || "You are a helpful AI assistant.",
          model: `${config.provider}/${apiModelId}`, // Format: "openai/gpt-5.2"
          tools: {}, // Tools will be added separately via ToolRegistry
        });

        // Convert CoreMessage[] to string[] for Mastra
        // Mastra accepts: string | string[] | CoreMessage[] | other formats
        // We'll use the simple string format for each message
        const mastraMessages = messages
          .map(
            (msg) =>
              `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`,
          )
          .join("\n\n");

        // Configure provider options for reasoning models
        const providerOptions: Record<string, unknown> = {};
        if (config.provider === "openai" && config.reasoning?.effort) {
          // Use the reasoning effort from the model config
          providerOptions.openai = {
            reasoningEffort: config.reasoning.effort, // "low" | "medium" | "high" | "xhigh"
          };
        }

        // For Google Gemini models with thinking capabilities
        if (
          config.provider === "google" &&
          config.thinkingBudget !== undefined &&
          config.thinkingBudget > 0
        ) {
          providerOptions.google = {
            thinkingConfig: {
              includeThoughts: true, // Enable thought summaries in stream
              thinkingBudget: config.thinkingBudget, // Token budget for thinking
            },
          };
        }

        // Stream with Mastra
        const streamResult = await agent.stream(mastraMessages, {
          maxSteps: config.maxSteps || 50,
          providerOptions:
            Object.keys(providerOptions).length > 0
              ? (providerOptions as any)
              : undefined,
        });

        // Stream chunks - use proper Mastra types
        for await (const chunk of streamResult.fullStream) {
          const mastraChunk = chunk as MastraChunk;

          // Map Mastra chunk types to our StreamChunk types
          switch (mastraChunk.type) {
            case "text-delta": {
              const payload =
                mastraChunk.payload as unknown as MastraTextDeltaPayload;
              if (payload?.text) {
                const textChunk: StreamChunk = {
                  type: "text-delta",
                  payload: {
                    text: payload.text,
                  },
                  timestamp: new Date().toISOString(),
                };
                yield textChunk;

                if (callbacks?.onTextDelta) {
                  callbacks.onTextDelta({ text: payload.text });
                }
              }
              break;
            }

            case "reasoning-delta": {
              const payload =
                mastraChunk.payload as unknown as MastraReasoningDeltaPayload;
              if (payload?.text) {
                const thinkingChunk: StreamChunk = {
                  type: "reasoning-delta",
                  payload: {
                    text: payload.text,
                  },
                  timestamp: new Date().toISOString(),
                };
                yield thinkingChunk;
              }
              break;
            }

            case "tool-call": {
              const payload =
                mastraChunk.payload as unknown as MastraToolCallPayload;
              if (payload?.toolName) {
                const toolChunk: StreamChunk = {
                  type: "tool-call",
                  payload: {
                    toolName: payload.toolName,
                    args: payload.args || {},
                  },
                  timestamp: new Date().toISOString(),
                };
                yield toolChunk;
              }
              break;
            }
          }
        }

        // Get final result
        const output = await streamResult.getFullOutput();
        const assistantContent = output.text || "";

        // Save assistant message
        const assistantMsg: CoreMessage = {
          role: "assistant",
          content: assistantContent,
        };
        await this.sessionManager.saveMessage(chatId, assistantMsg);

        // Emit done chunk
        const doneChunk: StreamChunk = {
          type: "done",
          payload: {
            usage: output.totalUsage
              ? {
                  // Mastra's LanguageModelUsage type doesn't expose prompt/completion tokens
                  // but they exist at runtime. Safe to cast.
                  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
                  promptTokens: (output.totalUsage as any).promptTokens || 0,
                  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
                  completionTokens:
                    (output.totalUsage as any).completionTokens || 0,
                  totalTokens: output.totalUsage.totalTokens || 0,
                }
              : undefined,
          },
          timestamp: new Date().toISOString(),
        };
        yield doneChunk;

        if (callbacks?.onDone) {
          // payload matches DonePayload structure from StreamingCallbacks
          // oxlint-disable-next-line @typescript-eslint/no-explicit-any
          callbacks.onDone(doneChunk.payload as any);
        }
      } finally {
        // Restore original API key
        if (originalKey !== undefined) {
          process.env[envKeyName] = originalKey;
        } else {
          delete process.env[envKeyName];
        }
      }
    } catch (error: unknown) {
      console.error("[MastraAgent] Stream error caught:", error);
      if (error instanceof Error) {
        console.error("[MastraAgent] Error stack:", error.stack);
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const errorChunk: StreamChunk = {
        type: "error",
        payload: {
          error: errorMessage,
        },
        timestamp: new Date().toISOString(),
      };
      yield errorChunk;

      if (callbacks?.onError) {
        callbacks.onError({ error: errorMessage });
      }
    }
  }

  /**
   * Get session manager
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }
}
