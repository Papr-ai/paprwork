/**
 * Agent WebSocket Handlers
 *
 * Replaces agent IPC handlers with WebSocket messages
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendResponse, sendError } from "./index.js";
import { getAgentService } from "../services/AgentService.js";
import type { AgentConfig } from "../../core/types/agents.js";
import type { UiAgentFocusContext } from "../../core/types/agentFocus.js";
import type { StoredMessageAttachment } from "../services/storage/IStorageProvider.js";

interface StreamPayload {
  chatId: string;
  message: string;
  config: AgentConfig;
  focusContext?: UiAgentFocusContext;
  attachments?: StoredMessageAttachment[];
}

interface StopStreamingPayload {
  chatId: string;
}

interface ChatHistoryPayload {
  chatId: string;
  limit?: number;
  skip?: number;
}

interface SubscribePayload {
  chatId: string;
  requestId: string;
  /** Skip buffered chunks the client already rendered before disconnect */
  fromChunkIndex?: number;
}

interface GenerateTitlePayload {
  chatId: string;
  message: string;
}

/**
 * Setup agent WebSocket handlers
 * Supports parallel streaming with chatId-based routing
 */
export async function setupAgentHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const agentService = getAgentService();

  try {
    switch (message.type) {
      case "agent:stream": {
        const payload = message.payload as StreamPayload;
        const { chatId, message: userMessage, config, focusContext, attachments } =
          payload;

        if (!chatId || !userMessage) {
          sendError(ws, message.id, "Missing chatId or message");
          return;
        }

        // ✅ OPTIMIZATION: Check if session exists first (reuse cached API key)
        const sessionManager = agentService.getSessionManager();
        const existingSession = sessionManager
          .getAllActiveSessions()
          .find((s) => s.chatId === chatId);

        let apiKey: string;
        let authType: "oauth" | "apiKey" | undefined;
        let usePaprProxy = false;

        if (
          existingSession &&
          agentService.isSameProvider(existingSession.config, config)
        ) {
          // Reuse API key and auth type from existing session (ZERO keychain access!)
          apiKey = existingSession.config.apiKey;
          authType = existingSession.config.authType;
          usePaprProxy = existingSession.config.usePaprProxy || false;
          console.log(
            `[Agent WS] Reusing cached API key for chat ${chatId} (${config.provider})`,
          );
        } else {
          // Fetch API key via IPC (secure method - never sent over WebSocket)
          // Only happens on first message or when switching providers
          const t2 = performance.now();
          try {
            // Ollama doesn't require an API key (runs locally)
            if (config.provider === "ollama") {
              apiKey = ""; // No API key needed for local Ollama
              authType = "apiKey"; // Use apiKey type for consistency
            }
            // Composer routes through Papr Cursor delegation (PAPR_API_KEY only)
            else if (config.provider === "cursor") {
              const { getApiKeys } = await import("../utils/keyResolver.js");
              const paprKeys = await getApiKeys(["PAPR_API_KEY"]);
              if (!paprKeys.PAPR_API_KEY) {
                sendError(
                  ws,
                  message.id,
                  "Composer requires Papr login. Sign in with Papr to use Cursor Composer.",
                );
                return;
              }
              apiKey = paprKeys.PAPR_API_KEY;
              authType = "apiKey";
            }
            // For openai, openai-codex, and anthropic, use getProviderAuth which handles OAuth
            else if (
              config.provider === "openai" ||
              config.provider === "openai-codex" ||
              config.provider === "anthropic"
            ) {
              const { getProviderAuthForModel } =
                await import("../utils/keyResolver.js");
              const authProvider =
                config.provider === "openai-codex" ? "openai" : config.provider;
              const auth = await getProviderAuthForModel(authProvider, {
                modelId: config.model,
                modelProvider: config.provider,
              });

              if (!auth) {
                // No direct provider auth — try Papr API key as proxy fallback
                const { getApiKeys } = await import("../utils/keyResolver.js");
                const paprKeys = await getApiKeys(["PAPR_API_KEY"]);
                if (paprKeys.PAPR_API_KEY) {
                  console.log(
                    `[Agent WS] No direct ${config.provider} auth — falling back to Papr AI proxy`,
                  );
                  apiKey = paprKeys.PAPR_API_KEY;
                  authType = "apiKey";
                  usePaprProxy = true;
                } else {
                  const { requiresOpenAIPlatformApiKey } =
                    await import("../utils/modelNormalizer.js");
                  const needsPlatformKey = requiresOpenAIPlatformApiKey(
                    config.model,
                  );
                  sendError(
                    ws,
                    message.id,
                    needsPlatformKey
                      ? `${config.model} requires an OpenAI API key. It is no longer available via ChatGPT OAuth.`
                      : `No authentication found for provider: ${config.provider}`,
                  );
                  return;
                }
              } else {
                apiKey = auth.type === "oauth" ? auth.token : auth.key;
                authType = auth.type;
              }
              
              console.log(
                `[Agent WS] Auth resolved for ${config.provider}: type=${authType} tokenLength=${apiKey?.length || 0} ` +
                `tokenPrefix=${apiKey?.substring(0, 15)}...`
              );
            } else {
              // For other providers, use standard key lookup
              const { getApiKeys } = await import("../utils/keyResolver.js");
              const keyName = `${config.provider.toUpperCase()}_API_KEY`;
              const keys = await getApiKeys([keyName]);
              apiKey = keys[keyName];

              if (!apiKey) {
                // No direct key — try Papr API key as proxy fallback
                const paprKeys = await getApiKeys(["PAPR_API_KEY"]);
                if (paprKeys.PAPR_API_KEY) {
                  console.log(
                    `[Agent WS] No ${keyName} found — falling back to Papr AI proxy`,
                  );
                  apiKey = paprKeys.PAPR_API_KEY;
                  usePaprProxy = true;
                } else {
                  sendError(ws, message.id, `API key not found: ${keyName}`);
                  return;
                }
              }
            }

            console.log(
              `[Agent WS] Fetched API key for chat ${chatId} (${config.provider}) in ${(performance.now() - t2).toFixed(2)}ms`,
            );
          } catch (keyError) {
            console.error(`[Agent WS] Failed to fetch API key:`, keyError);
            sendError(ws, message.id, "Failed to fetch API key");
            return;
          }
        }

        // Create internal config with API key and auth type (for OAuth vs API key routing)
        const configInternal = { ...config, apiKey, authType, usePaprProxy };

        // Log which authentication method is being used
        if (usePaprProxy) {
          console.log(
            `[Agent WS] 🔑 Using PAPR PROXY for ${config.provider}/${config.model} (no direct API key found)`
          );
        } else if (authType === "oauth") {
          console.log(
            `[Agent WS] 🔑 Using OAUTH for ${config.provider}/${config.model}`
          );
        } else {
          console.log(
            `[Agent WS] 🔑 Using DIRECT API KEY for ${config.provider}/${config.model}`
          );
        }

        // Track message_sent event
        const { getGatewayTelemetry } = await import("../services/gatewayTelemetry.js");
        getGatewayTelemetry().trackFireAndForget("paprwork_message_sent", {
          chat_id: chatId,
          message_length: userMessage.length,
          model: config.model,
          provider: config.provider,
          auth_type: authType ?? "apiKey",
          uses_papr_proxy: usePaprProxy,
        });

        const { getAgentStreamRegistry } = await import(
          "../services/AgentStreamRegistry.js"
        );

        getAgentStreamRegistry().startStream({
          chatId,
          requestId: message.id,
          userMessage,
          config: configInternal,
          focusContext,
          attachments,
          ws,
        });
        break;
      }

      case "agent:subscribe": {
        const { chatId, requestId, fromChunkIndex = 0 } =
          message.payload as SubscribePayload;

        if (!chatId || !requestId) {
          sendError(ws, message.id, "Missing chatId or requestId");
          return;
        }

        const { getAgentStreamRegistry } = await import(
          "../services/AgentStreamRegistry.js"
        );
        const registry = getAgentStreamRegistry();

        let targetRequestId = requestId;
        let result = registry.addSubscriber(
          ws,
          message.id,
          chatId,
          targetRequestId,
          fromChunkIndex,
        );

        if (!result.found) {
          const activeRequestId = registry.getRequestIdForChat(chatId);
          if (activeRequestId) {
            targetRequestId = activeRequestId;
            result = registry.addSubscriber(
              ws,
              message.id,
              chatId,
              targetRequestId,
              fromChunkIndex,
            );
          }
        }

        if (!result.found) {
          const stillStreaming = agentService.isStreaming(chatId);
          if (stillStreaming) {
            sendError(
              ws,
              message.id,
              "Stream is active but not available for replay yet. Retry shortly.",
            );
            return;
          }

          sendError(
            ws,
            message.id,
            "No active stream found for chat. Reload history to sync.",
          );
          return;
        }

        console.log(
          `[Agent WS] Subscribed to stream ${targetRequestId} for chat ${chatId} ` +
            `(replayed ${result.replayed}/${result.totalBuffered} chunks from index ${fromChunkIndex})`,
        );
        break;
      }

      case "agent:stop": {
        const { chatId } = message.payload as StopStreamingPayload;

        if (!chatId) {
          sendError(ws, message.id, "Missing chatId");
          return;
        }

        await agentService.stopStreaming(chatId);

        const { getAgentStreamRegistry } = await import(
          "../services/AgentStreamRegistry.js"
        );
        getAgentStreamRegistry().cancelStream(chatId, "Stopped by user");

        console.log(`[Agent WS] Stopped streaming for chat ${chatId}`);

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { chatId },
        });
        break;
      }

      case "agent:history": {
        const { chatId, limit, skip } = message.payload as ChatHistoryPayload;
        const history = await agentService.getChatHistory(chatId, limit, skip);

        // StoredMessage already has correct format (role, content) - no transformation needed
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: history,
        });
        break;
      }

      case "agent:generate-title": {
        const { chatId, message: firstMessage } =
          message.payload as GenerateTitlePayload;

        if (!chatId || !firstMessage) {
          sendError(ws, message.id, "Missing chatId or message");
          return;
        }

        const title = await agentService.generateChatTitle(
          chatId,
          firstMessage,
        );

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { title },
        });
        break;
      }

      case "agent:sessions": {
        const sessions = agentService.getActiveSessions();
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: {
            sessions: sessions.map((s) => ({
              chatId: s.chatId,
              isStreaming: s.isStreaming,
              model: s.config.model,
              provider: s.config.provider,
            })),
          },
        });
        break;
      }

      case "agent:get-cost-stats": {
        const globalStats = await agentService.getGlobalCostStats();
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: globalStats,
        });
        break;
      }

      case "agent:get-chat-cost": {
        const payload = message.payload as { chatId?: string };
        const chatId = payload?.chatId;
        if (!chatId) {
          sendError(ws, message.id, "chatId is required");
          return;
        }
        const chatCost = await agentService.getChatCost(chatId);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: chatCost,
        });
        break;
      }

      case "agent:get-cost-trends": {
        const payload = message.payload as { days?: number };
        const days = payload?.days || 30;
        const trends = await agentService.getDailyCostTrends(days);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: trends,
        });
        break;
      }

      case "agent:get-model-distribution": {
        const distribution = await agentService.getModelDistribution();
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: distribution,
        });
        break;
      }

      case "agent:get-agent-stats": {
        const payload = message.payload as { agentId?: string };
        const agentId = payload?.agentId;
        if (!agentId) {
          sendError(ws, message.id, "agentId is required");
          return;
        }
        const stats = await agentService.getAgentStats(agentId);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: stats,
        });
        break;
      }

      case "agent:get-all-agent-stats": {
        const stats = await agentService.getAllAgentStats();
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: stats,
        });
        break;
      }

      case "agent:get-outputs": {
        const payload = message.payload as { agentId?: string };
        const agentId = payload?.agentId;
        const outputs = await agentService.getAgentOutputs(agentId);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: outputs,
        });
        break;
      }

      case "agent:get-context-efficiency": {
        const stats = agentService.getContextEfficiencyStats();
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: stats,
        });
        break;
      }

      case "agent:get-tool-usage": {
        const usage = agentService.getToolUsageByAgent();
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: usage,
        });
        break;
      }

      default:
        sendError(
          ws,
          message.id,
          `Unknown agent message type: ${message.type}`,
        );
    }
  } catch (error) {
    console.error("[Agent WebSocket] Error:", error);
    if (error instanceof Error) {
      console.error("[Agent WebSocket] Stack:", error.stack);
    }
    sendError(ws, message.id, error as Error);
  }
}
