/**
 * Unified Papr cloud runtime streaming (Phase 3D).
 *
 * Routes Composer and future cloud providers through
 * POST /v1/cloud/runtime/sessions/stream on the memory server.
 */

import { getCloudRuntimeClient } from "../../utils/cloudRuntimeClient.js";
import { normalizeCursorModelId } from "../../types/cursorDelegation.js";
import type { CloudRuntimeStreamEvent } from "../../types/cloudRuntime.js";

export interface CloudRuntimeStreamInput {
  chatId: string;
  prompt: string;
  provider: string;
  modelId: string;
  paprApiKey: string;
  signal?: AbortSignal;
}

function isAgentNotFoundError(errorText: string): boolean {
  return (
    errorText.includes("agent_not_found") ||
    errorText.includes("Agent not found")
  );
}

export class CloudRuntimeService {
  private readonly agentIds = new Map<string, string>();

  hasAgent(chatId: string): boolean {
    return this.agentIds.has(chatId);
  }

  async *streamTurn(
    input: CloudRuntimeStreamInput,
  ): AsyncGenerator<CloudRuntimeStreamEvent | { type: "finish"; finishReason?: string }> {
    const model =
      input.provider === "cursor"
        ? normalizeCursorModelId(input.modelId)
        : input.modelId;
    const client = getCloudRuntimeClient();
    let retriedAgentNotFound = false;

    attempt: while (true) {
      const agentId = this.agentIds.get(input.chatId);

      for await (const event of client.streamSession(
        input.paprApiKey,
        {
          chatId: input.chatId,
          prompt: input.prompt,
          provider: input.provider,
          model,
          agentId,
          tier: "sandbox",
          runtime: "cloud",
        },
        input.signal,
      )) {
      if (event.type === "session-meta") {
        yield event;
        continue;
      }

      if (event.type === "agent-meta" && event.agentId) {
        this.agentIds.set(input.chatId, event.agentId);
        continue;
      }

      if (event.type === "text-delta" && event.text) {
        yield { type: "text-delta", text: event.text };
        continue;
      }

      if (event.type === "reasoning-start") {
        yield { type: "reasoning-start" };
        continue;
      }

      if (event.type === "reasoning-delta" && event.text) {
        yield { type: "reasoning-delta", text: event.text };
        continue;
      }

      if (event.type === "reasoning-end") {
        yield { type: "reasoning-end" };
        continue;
      }

      if (event.type === "tool-call" && event.toolCallId && event.toolName) {
        yield {
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? {},
        };
        continue;
      }

      if (event.type === "tool-result" && event.toolCallId && event.toolName) {
        yield {
          type: "tool-result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result ?? "",
        };
        continue;
      }

      if (event.type === "status" && event.message) {
        yield {
          type: "text-delta",
          text: `_${event.message}_\n`,
        };
        continue;
      }

      if (event.type === "error") {
        const errorText = event.error ?? event.message ?? "Cloud runtime error";
        if (isAgentNotFoundError(errorText)) {
          this.agentIds.delete(input.chatId);
          if (!retriedAgentNotFound) {
            retriedAgentNotFound = true;
            console.warn(
              `[CloudRuntime] Agent not found for chat ${input.chatId} — creating a fresh cloud agent`,
            );
            continue attempt;
          }
        }
        yield {
          type: "error",
          error: errorText,
        };
        continue;
      }

      if (event.type === "done") {
        if (event.agentId) {
          this.agentIds.set(input.chatId, event.agentId);
        }
        yield {
          type: "finish",
          finishReason: event.finishReason ?? "stop",
        };
      }
      }
      break attempt;
    }
  }

  disposeChat(chatId: string): void {
    this.agentIds.delete(chatId);
  }
}

let sharedService: CloudRuntimeService | undefined;

export function getCloudRuntimeService(): CloudRuntimeService {
  if (!sharedService) {
    sharedService = new CloudRuntimeService();
  }
  return sharedService;
}
