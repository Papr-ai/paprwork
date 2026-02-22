/**
 * Pi-to-AI-SDK Adapter - Converts pi-ai's AssistantMessageEventStream to our orchestrateModelStream format
 *
 * pi-ai events: text_delta, thinking_delta, toolcall_end, done, error
 * Our format:   text-delta, reasoning-delta, tool-call, tool-result, finish
 *
 * IMPORTANT: orchestrateModelStream expects chunk.text (not textDelta) and chunk.payload for createChatStreamChunk
 */

import type { AssistantMessageEvent } from "@mariozechner/pi-ai";

/** Chunks we yield - match what orchestrateModelStream expects */
type OurChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text: string }
  | { type: "reasoning-end" }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: string | Record<string, unknown>;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      result: unknown;
    }
  | { type: "finish"; finishReason: string }
  | { type: "error"; error: unknown };

/**
 * Convert pi-ai AssistantMessageEvent stream to our chunk format
 * Supports real-time streaming of text and reasoning deltas
 */
export async function* adaptPiStreamToAISDK(
  piStream: AsyncIterable<AssistantMessageEvent>,
): AsyncGenerator<OurChunk> {
  try {
    for await (const event of piStream) {
      switch (event.type) {
        case "text_delta": {
          const delta = event.delta;
          if (typeof delta === "string" && delta.length > 0) {
            yield { type: "text-delta", text: delta };
          }
          break;
        }
        case "thinking_start":
          yield { type: "reasoning-start" };
          break;
        case "thinking_delta": {
          const delta = event.delta;
          if (typeof delta === "string" && delta.length > 0) {
            yield { type: "reasoning-delta", text: delta };
          }
          break;
        }
        case "thinking_end":
          yield { type: "reasoning-end" };
          break;
        case "toolcall_end": {
          const toolCall = event.toolCall;
          if (toolCall) {
            yield {
              type: "tool-call",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args: toolCall.arguments ?? {},
            };
          }
          break;
        }
        case "done": {
          const reason = event.reason ?? "stop";
          const finishReason =
            reason === "toolUse"
              ? "tool-calls"
              : reason === "length"
                ? "length"
                : "stop";
          yield { type: "finish", finishReason };
          break;
        }
        case "error": {
          yield {
            type: "error",
            error:
              (event as { error?: { errorMessage?: string } }).error
                ?.errorMessage ?? event,
          };
          break;
        }
        default:
          // text_start, text_end, thinking_start, thinking_end, toolcall_start, toolcall_delta - ignore
          break;
      }
    }
  } catch (error) {
    yield { type: "error", error };
  }
}
