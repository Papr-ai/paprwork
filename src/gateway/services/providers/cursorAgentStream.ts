/**
 * Cursor provider stream path for AgentService.
 * Keeps Composer delegation isolated from Mastra / AI SDK / pi-ai routing.
 */

import { v4 as uuidv4 } from "uuid";
import type { AgentConfigInternal } from "../../../core/types/agents.js";
import type { StreamChunk } from "../../../core/types/streaming.js";
import { getApiKeysForSanitization } from "../../../core/tools/index.js";
import { orchestrateModelStream } from "../agent/streamOrchestrator.js";
import {
  createAssistantStoredMessage,
} from "../agent/messagePersistence.js";
import type {
  ToolCallEvent,
  ToolResultEvent,
} from "../agent/streamChunks.js";
import type { TokenUsageForCost } from "../CostCalculation.js";
import type { StoredMessage } from "../storage/IStorageProvider.js";
import type { ChatSessionManager } from "../ChatSessionManager.js";
import type { StorageManager } from "../StorageManager.js";
import { getCursorDelegationService } from "./CursorDelegationService.js";
import { getCloudRuntimeService } from "./CloudRuntimeService.js";
import { getCloudSyncService } from "../CloudSyncService.js";
import { syncTursoBeforeCloudRun } from "../TursoSyncBridge.js";

interface CursorStreamOptions {
  allowedToolIds?: string[];
  maxSteps?: number;
  _isSilentRetry?: boolean;
  _skipSaveUserMessage?: boolean;
}

function finalizeTokenUsageForBilling(
  usage: (TokenUsageForCost & { totalTokens: number }) | undefined,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): (TokenUsageForCost & { totalTokens: number }) | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    ...usage,
    cacheReadTokens: usage.cacheReadTokens ?? cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens ?? cacheWriteTokens,
  };
}

interface CursorStreamDeps {
  sessionManager: ChatSessionManager;
  storageManager: StorageManager;
}

export async function* streamCursorAgentTurn(
  deps: CursorStreamDeps,
  chatId: string,
  userMessage: string,
  config: AgentConfigInternal,
  options?: CursorStreamOptions,
): AsyncGenerator<StreamChunk & { chatId: string }> {
  const { sessionManager, storageManager } = deps;
  const abortController = new AbortController();
  sessionManager.setAbortController(chatId, abortController);
  sessionManager.setStreaming(chatId, true);

  let assistantText = "";
  let thinkingText = "";
  let toolCalls: ToolCallEvent[] = [];
  let toolResults: ToolResultEvent[] = [];
  let sequence: Array<{ type: "text" | "tool" | "thinking"; data: unknown }> =
    [];

  const cloudSync = getCloudSyncService();
  const cloudRuntime = getCloudRuntimeService();
  const isResumingCloudAgent = cloudRuntime.hasAgent(chatId);

  try {
    if (!config.apiKey) {
      throw new Error(
        "Composer requires Papr login. Sign in with Papr to use Cursor Composer.",
      );
    }

    // Git/Turso prep only on first turn in a chat — resume turns reuse the cloud agent.
    if (!isResumingCloudAgent) {
      if (cloudSync) {
        void cloudSync.prepareForComposerRun(true);
      }
      void syncTursoBeforeCloudRun().catch((err: Error) => {
        console.warn(
          "[CursorAgentStream] Background Turso pre-sync failed:",
          err.message.slice(0, 120),
        );
      });
    }

    if (!options?._skipSaveUserMessage) {
      const userMsg: StoredMessage = {
        id: `msg-${uuidv4()}`,
        chat_id: chatId,
        role: "user",
        content: userMessage,
        timestamp: new Date().toISOString(),
        sync_status: "local",
      };
      await storageManager.saveMessage(chatId, userMsg);
    }

    const cursorService = getCursorDelegationService();
    const rawStream = cursorService.streamTurn({
      chatId,
      prompt: userMessage,
      modelId: config.model,
      paprApiKey: config.apiKey,
      signal: abortController.signal,
    });

    const apiKeys = getApiKeysForSanitization();
    const streamIterator = orchestrateModelStream(rawStream, chatId, apiKeys);

    while (true) {
      const next = await streamIterator.next();
      if (next.done) {
        assistantText = next.value.assistantText;
        thinkingText = next.value.thinkingText;
        toolCalls = next.value.toolCalls;
        toolResults = next.value.toolResults;
        sequence = next.value.sequence;
        break;
      }
      yield next.value;
    }

    const assistantMsg: StoredMessage = createAssistantStoredMessage({
      chatId,
      model: config.model,
      assistantText,
      thinkingText,
      toolCalls,
      toolResults,
      sequence,
      usage: finalizeTokenUsageForBilling(undefined, 0, 0),
    });
    await storageManager.saveMessage(chatId, assistantMsg);

    yield {
      type: "done",
      payload: {
        messageId: assistantMsg.id,
      },
      timestamp: new Date().toISOString(),
      chatId,
    } as StreamChunk & { chatId: string };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[CursorAgentStream] Error for chat ${chatId}:`, message);
    yield {
      type: "error",
      payload: { error: message },
      timestamp: new Date().toISOString(),
      chatId,
    } as StreamChunk & { chatId: string };
  } finally {
    sessionManager.setStreaming(chatId, false);
    sessionManager.setAbortController(chatId, null);

    void (async () => {
      if (cloudSync) {
        try {
          await cloudSync.pullNow();
        } catch (err) {
          console.warn(
            "[CursorAgentStream] Post-run sync pull failed:",
            (err as Error).message.slice(0, 120),
          );
        }
      }
    })();
  }
}
