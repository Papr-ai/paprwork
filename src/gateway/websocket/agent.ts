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

interface StreamPayload {
  chatId: string;
  message: string;
  config: AgentConfig;
}

interface StopStreamingPayload {
  chatId: string;
}

interface ChatHistoryPayload {
  chatId: string;
  limit?: number;
  skip?: number;
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
        const { chatId, message: userMessage, config } = payload;

        if (!chatId || !userMessage) {
          sendError(ws, message.id, "Missing chatId or message");
          return;
        }

        // ⏱️ PERFORMANCE TRACKING: Start timing
        const perfStart = performance.now();
        const timings: Record<string, number> = {};

        // ✅ OPTIMIZATION: Check if session exists first (reuse cached API key)
        const t1 = performance.now();
        const sessionManager = agentService.getSessionManager();
        const existingSession = sessionManager
          .getAllActiveSessions()
          .find((s) => s.chatId === chatId);
        timings.sessionLookup = performance.now() - t1;

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
          timings.keyFetch = 0; // Cache hit
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

            timings.keyFetch = performance.now() - t2;
            console.log(
              `[Agent WS] Fetched API key for chat ${chatId} (${config.provider}) in ${timings.keyFetch.toFixed(2)}ms`,
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

        // Track time until first chunk
        const t3 = performance.now();
        timings.beforeStream = performance.now() - perfStart;

        // Stream response chunks back to client
        // Each chunk includes chatId for frontend routing
        // Wrap in runWithToolContext so delegate_task and other tools get chatId via getCurrentChatId()
        console.log(
          `[Agent WS] Starting stream for chat ${chatId} (setup took ${timings.beforeStream.toFixed(2)}ms)`,
        );
        let chunkCount = 0;
        let firstChunkTime: number | null = null;

        const { runWithToolContext } = await import(
          "../../core/tools/context.js"
        );

        try {
          await runWithToolContext(chatId, async () => {
            for await (const chunk of agentService.streamAgent(
              chatId,
              userMessage,
              configInternal,
            )) {
              if (firstChunkTime === null) {
                firstChunkTime = performance.now() - t3;
                timings.timeToFirstChunk = firstChunkTime;
                console.log(
                  `[Agent WS] ⚡ First chunk received in ${firstChunkTime.toFixed(2)}ms (type: ${chunk.type})`,
                );
              }

              chunkCount++;

              if (ws.readyState === ws.OPEN) {
                // Send chunk with chatId for parallel stream routing
                ws.send(
                  JSON.stringify({
                    id: message.id,
                    type: "agent:chunk",
                    data: chunk, // chunk already includes chatId from streamAgent
                  }),
                );
              } else {
                console.warn(`[Agent WS] WebSocket closed for chat ${chatId}`);
                break;
              }
            }
          });

          timings.totalStreamTime = performance.now() - perfStart;

          getGatewayTelemetry().trackFireAndForget("paprwork_message_received", {
            chat_id: chatId,
            response_time_ms: Math.round(timings.totalStreamTime),
            model: config.model,
            provider: config.provider,
            chunk_count: chunkCount,
          });

          console.log(`[Agent WS] Stream complete for chat ${chatId}.`);
          console.log(`[Agent WS]   Chunks: ${chunkCount}`);
          console.log(
            `[Agent WS]   Session lookup: ${timings.sessionLookup.toFixed(2)}ms`,
          );
          console.log(
            `[Agent WS]   Key fetch: ${timings.keyFetch.toFixed(2)}ms`,
          );
          console.log(
            `[Agent WS]   Time to first chunk: ${timings.timeToFirstChunk?.toFixed(2) || "N/A"}ms`,
          );
          console.log(
            `[Agent WS]   Total time: ${timings.totalStreamTime.toFixed(2)}ms`,
          );

          // Load the final saved message (includes sequence) and send it
          const messages = await agentService.getChatHistory(chatId);
          const finalMessage = messages[messages.length - 1]; // Last message is the assistant response

          // Send completion with final message data (includes sequence)
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                id: message.id,
                type: "agent:complete",
                data: {
                  chatId,
                  done: true,
                  finalMessage, // Include complete message with sequence
                },
              }),
            );
          }
        } catch (streamError) {
          console.error(
            `[Agent WS] Stream error for chat ${chatId}:`,
            streamError,
          );

          // Send error
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                id: message.id,
                type: "agent:error",
                data: {
                  chatId,
                  error:
                    streamError instanceof Error
                      ? streamError.message
                      : "Stream error",
                },
              }),
            );
          }
        }
        break;
      }

      case "agent:stop": {
        const { chatId } = message.payload as StopStreamingPayload;

        if (!chatId) {
          sendError(ws, message.id, "Missing chatId");
          return;
        }

        await agentService.stopStreaming(chatId);
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
