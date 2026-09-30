/**
 * Pi-to-AI-SDK Adapter - Converts pi-ai's AssistantMessageEventStream to our orchestrateModelStream format
 *
 * pi-ai events: text_delta, thinking_delta, toolcall_end, done, error
 * Our format:   text-delta, reasoning-delta, tool-call, tool-result, finish
 *
 * IMPORTANT: orchestrateModelStream expects chunk.text (not textDelta) and chunk.payload for createChatStreamChunk
 */

import type { AssistantMessageEvent } from "@mariozechner/pi-ai";

/**
 * Truncate tool call ID to 64 characters (OpenAI's maximum length requirement).
 * IDs from various APIs may exceed this limit, causing validation errors.
 */
function truncateToolCallId(id: string): string {
  return id.length > 64 ? id.substring(0, 64) : id;
}

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
  // pi-ai's contract: every stream ends with exactly one terminal event —
  // `done` (stop | length | toolUse) or `error` (aborted | error). If the
  // iterator ends without either, the provider closed the socket gracefully
  // mid-turn (idle timeout, proxy close). Without this guard the caller
  // cannot distinguish that from a real completion: the message is saved as
  // complete with incomplete=0 and zero usage, and the turn is silently lost.
  let terminated = false;
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
              toolCallId: truncateToolCallId(toolCall.id),
              toolName: toolCall.name,
              args: toolCall.arguments ?? {},
            };
          }
          break;
        }
        case "done": {
          terminated = true;
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
          terminated = true;
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
    terminated = true;
    yield { type: "error", error };
  }

  if (!terminated) {
    yield {
      type: "error",
      error:
        "STREAM_ENDED_EARLY: provider closed the stream without a done/error event",
    };
  }
}
