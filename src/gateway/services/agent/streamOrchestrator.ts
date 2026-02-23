import {
  sanitizeToolOutput,
  truncateResult,
} from "../../../core/tools/index.js";
import {
  createChatStreamChunk,
  parseToolCallChunk,
  parseToolErrorChunk,
  parseToolResultChunk,
  truncateStringsInUnknown,
  type ChatStreamChunk,
  type ToolCallEvent,
  type ToolResultEvent,
} from "./streamChunks.js";

export interface StreamOrchestratorResult {
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallEvent[];
  toolResults: ToolResultEvent[];
  sequence: Array<{ type: "text" | "tool" | "thinking"; data: any }>; // V1-style sequence for interleaving
}

/**
 * Extract a user-friendly error message from API errors
 * Handles cases where error is an object with nested error details
 */
function extractErrorMessage(error: unknown): string {
  // If it's already a string, return it
  if (typeof error === "string") {
    return error;
  }

  // If it's an Error object, return message
  if (error instanceof Error) {
    return error.message;
  }

  // If it's an object, try to extract meaningful error info
  if (typeof error === "object" && error !== null) {
    const errorObj = error as Record<string, unknown>;

    // Check for common API error patterns
    // Pattern 1: { message: "..." }
    if (typeof errorObj.message === "string") {
      return errorObj.message;
    }

    // Pattern 2: { error: { message: "..." } }
    if (
      typeof errorObj.error === "object" &&
      errorObj.error !== null &&
      typeof (errorObj.error as Record<string, unknown>).message === "string"
    ) {
      return (errorObj.error as Record<string, unknown>).message as string;
    }

    // Pattern 3: { data: { error: { message: "..." } } }
    if (
      typeof errorObj.data === "object" &&
      errorObj.data !== null &&
      typeof (errorObj.data as Record<string, unknown>).error === "object" &&
      (errorObj.data as Record<string, unknown>).error !== null
    ) {
      const dataError = (errorObj.data as Record<string, unknown>)
        .error as Record<string, unknown>;
      if (typeof dataError.message === "string") {
        return dataError.message;
      }
    }

    // Try to stringify if we haven't found a message
    try {
      return JSON.stringify(errorObj);
    } catch {
      return "[Unserializable error object]";
    }
  }

  return "Unknown error";
}

export async function* orchestrateModelStream(
  fullStream: AsyncIterable<unknown>,
  chatId: string,
  apiKeys: string[],
): AsyncGenerator<ChatStreamChunk, StreamOrchestratorResult> {
  const TEXT_BUFFER_MIN = 50;
  const REASONING_BUFFER_MIN = 1; // Stream reasoning in real-time (no batching)
  let textBuffer = "";
  let reasoningBuffer = "";

  let assistantText = "";
  let thinkingText = "";
  
  // Memory safety: Track size and enforce per-stream caps
  const MAX_REASONING_SIZE = 100_000; // 100KB max reasoning per stream (enough for most cases)
  const MAX_TEXT_SIZE = 500_000; // 500KB max assistant text per stream
  
  const toolCalls: ToolCallEvent[] = [];
  const toolResults: ToolResultEvent[] = [];

  // Buffer tool results so we can keep the last one full (truncate only prior ones)
  const toolResultBuffer: Array<{
    toolCallId: string;
    toolName: string;
    result: unknown;
  }> = [];

  // Build V1-style sequence for interleaving text and tool calls
  const sequence: Array<{ type: "text" | "tool" | "thinking"; data: any }> = [];
  let currentTextSegment = ""; // Accumulate text between tool calls

  function* flushToolResultBuffer(): Generator<ChatStreamChunk> {
    if (toolResultBuffer.length === 0) return;
    const lastIdx = toolResultBuffer.length - 1;
    for (let i = 0; i < toolResultBuffer.length; i++) {
      const item = toolResultBuffer[i];
      let result = item.result;
      if (i < lastIdx) {
        if (typeof result === "string") {
          result = truncateResult(result);
        } else if (result && typeof result === "object") {
          result = truncateStringsInUnknown(result);
        }
      }
      const toolResult: ToolResultEvent = {
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        result,
      };
      toolResults.push(toolResult);
      const toolCall = toolCalls.find(
        (tc) => tc.toolCallId === toolResult.toolCallId,
      );
      if (toolCall) {
        const toolIndex = sequence.findIndex(
          (s) =>
            s.type === "tool" &&
            (s.data as { toolCallId?: string }).toolCallId ===
              toolResult.toolCallId,
        );
        if (toolIndex !== -1) {
          sequence[toolIndex].data = {
            name: toolCall.toolName,
            input: toolCall.args,
            output: toolResult.result,
            status: "success",
            toolCallId: toolResult.toolCallId,
          };
        }
      }
      yield createChatStreamChunk(
        "tool-result",
        {
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          result: toolResult.result,
          success: true,
        },
        chatId,
      );
    }
    toolResultBuffer.length = 0;
  }

  for await (const rawChunk of fullStream) {
    if (typeof rawChunk !== "object" || rawChunk === null) {
      continue;
    }

    const chunk = rawChunk as {
      type?: unknown;
      text?: unknown;
      error?: unknown;
    };
    const chunkType = chunk.type;
    if (chunkType !== "text-delta") {
      console.log(`[AgentService] Received chunk type: ${String(chunkType)}`);
    }

    // Flush buffered tool results before non-tool-result chunks (keeps last full)
    if (chunkType !== "tool-result") {
      yield* flushToolResultBuffer();
    }

    switch (chunkType) {
      case "start-step": {
        // New step starts - if we have accumulated text, it belongs to previous step
        // We'll flush it when we see the tool-call for THIS step
        console.log("[StreamOrchestrator] Step starting...");
        break;
      }

      case "text-delta": {
        const text = typeof chunk.text === "string" ? chunk.text : "";
        textBuffer += text;
        currentTextSegment += text; // Accumulate for sequence

        // Memory safety: Cap per-stream text to prevent OOM with concurrent streams
        if (assistantText.length + text.length > MAX_TEXT_SIZE) {
          console.warn(
            `[StreamOrchestrator] Chat ${chatId}: Text capped at ${(MAX_TEXT_SIZE / 1000).toFixed(0)}KB to prevent OOM (${assistantText.length + text.length} bytes requested)`,
          );
          // Truncate to fit within cap
          const remaining = MAX_TEXT_SIZE - assistantText.length;
          if (remaining > 0) {
            assistantText += text.substring(0, remaining);
          }
        } else {
          assistantText += text;
        }

        if (textBuffer.length >= TEXT_BUFFER_MIN) {
          yield createChatStreamChunk(
            "text-delta",
            { text: textBuffer },
            chatId,
          );
          textBuffer = "";
        }
        break;
      }

      case "text-end": {
        // Text for this step is complete - it will be followed by tool-call
        // Flush any remaining text buffer to ensure UI gets complete text before tool call
        if (textBuffer.length > 0) {
          console.log(
            `[StreamOrchestrator] Flushing text buffer (${textBuffer.length} chars) at text-end`,
          );
          yield createChatStreamChunk(
            "text-delta",
            { text: textBuffer },
            chatId,
          );
          textBuffer = "";
        }
        const trimmed = currentTextSegment.trim();
        if (trimmed) {
          console.log(
            `[StreamOrchestrator] Text segment complete (before tool): "${trimmed.substring(0, 50)}..."`,
          );
        }
        break;
      }

      case "reasoning-start": {
        console.log("[AgentService] Reasoning started");
        // Flush text buffer before reasoning starts
        if (textBuffer.length > 0) {
          console.log(
            `[StreamOrchestrator] Flushing text buffer (${textBuffer.length} chars) before reasoning`,
          );
          yield createChatStreamChunk(
            "text-delta",
            { text: textBuffer },
            chatId,
          );
          textBuffer = "";
        }
        break;
      }

      case "reasoning-delta": {
        const reasoningText = typeof chunk.text === "string" ? chunk.text : "";
        reasoningBuffer += reasoningText;

        // Memory safety: Cap per-stream reasoning to prevent OOM with concurrent streams
        if (thinkingText.length + reasoningText.length > MAX_REASONING_SIZE) {
          if (thinkingText.length < MAX_REASONING_SIZE) {
            // First time hitting cap - log warning
            console.warn(
              `[StreamOrchestrator] Chat ${chatId}: Reasoning capped at ${(MAX_REASONING_SIZE / 1000).toFixed(0)}KB to prevent OOM`,
            );
          }
          // Truncate to fit within cap
          const remaining = MAX_REASONING_SIZE - thinkingText.length;
          if (remaining > 0) {
            thinkingText += reasoningText.substring(0, remaining);
          }
          // Still stream to UI (user sees it), but don't store beyond cap
        } else {
          thinkingText += reasoningText;
        }

        if (reasoningBuffer.length >= REASONING_BUFFER_MIN) {
          yield createChatStreamChunk(
            "reasoning-delta",
            { text: reasoningBuffer },
            chatId,
          );
          reasoningBuffer = "";
        }
        break;
      }

      case "reasoning-end": {
        console.log(
          `[AgentService] Chat ${chatId}: Reasoning ended (${(thinkingText.length / 1000).toFixed(0)}KB)`,
        );
        if (reasoningBuffer.length > 0) {
          yield createChatStreamChunk(
            "reasoning-delta",
            { text: reasoningBuffer },
            chatId,
          );
          reasoningBuffer = "";
        }
        // Add thinking to sequence when complete
        if (thinkingText) {
          sequence.push({ type: "thinking", data: thinkingText });
        }
        break;
      }

      case "tool-call": {
        const toolCall = parseToolCallChunk(rawChunk);
        if (!toolCall) break;

        toolCalls.push(toolCall);

        // CRITICAL: Flush text buffer to UI before tool call
        // This ensures all text before the tool call is sent to the UI first
        if (textBuffer.length > 0) {
          console.log(
            `[StreamOrchestrator] Flushing text buffer (${textBuffer.length} chars) before tool call`,
          );
          yield createChatStreamChunk(
            "text-delta",
            { text: textBuffer },
            chatId,
          );
          textBuffer = "";
        }

        // Flush accumulated text from this step's narration (comes before tool-call)
        if (currentTextSegment.trim()) {
          const trimmed = currentTextSegment.trim();
          console.log(
            `[StreamOrchestrator] Adding text to sequence (#${sequence.length + 1}): "${trimmed.substring(0, 50)}..."`,
          );
          sequence.push({ type: "text", data: trimmed });
          currentTextSegment = ""; // Reset for next step
        }

        // Add tool to sequence immediately (will update with result later)
        console.log(
          `[StreamOrchestrator] Adding tool to sequence (#${sequence.length + 1}): ${toolCall.toolName}`,
        );
        sequence.push({
          type: "tool",
          data: {
            name: toolCall.toolName,
            input: toolCall.args,
            status: "calling", // Tool is running
            toolCallId: toolCall.toolCallId, // Keep for reliable result matching
          },
        });

        yield createChatStreamChunk(
          "tool-call",
          {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            args: toolCall.args,
          },
          chatId,
        );
        break;
      }

      case "tool-result": {
        const parsedToolResult = parseToolResultChunk(rawChunk);
        if (!parsedToolResult) break;

        const rawResult = parsedToolResult.result;
        const sanitizedResult = sanitizeToolOutput(rawResult, apiKeys);
        const rawSize =
          typeof rawResult === "string"
            ? rawResult.length
            : JSON.stringify(rawResult).length;
        console.log(
          `[AgentService] Tool ${parsedToolResult.toolName} raw result: ${rawSize} chars`,
        );

        // Buffer for flush - last one stays full
        toolResultBuffer.push({
          toolCallId: parsedToolResult.toolCallId,
          toolName: parsedToolResult.toolName,
          result: sanitizedResult,
        });
        break;
      }

      case "error": {
        const sanitizedError = sanitizeToolOutput(chunk.error, apiKeys);
        const errorMessage = extractErrorMessage(sanitizedError);
        yield createChatStreamChunk("error", { error: errorMessage }, chatId);
        break;
      }

      case "tool-error": {
        const toolError = parseToolErrorChunk(rawChunk);
        if (!toolError) break;

        const sanitizedError = sanitizeToolOutput(
          toolError.error || JSON.stringify(toolError),
          apiKeys,
        );
        console.error(
          `[AgentService] Tool error (${toolError.toolName || "unknown"}):`,
          sanitizedError,
        );

        yield createChatStreamChunk(
          "tool-error",
          {
            toolCallId: toolError.toolCallId,
            toolName: toolError.toolName || "unknown-tool",
            error: String(sanitizedError),
          },
          chatId,
        );
        break;
      }

      case "finish-step": {
        // AI SDK provides usage data in finish-step events
        const finishStepChunk = rawChunk as {
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
          };
          finishReason?: string;
        };

        if (finishStepChunk.usage) {
          const usage = finishStepChunk.usage;
          console.log(
            `[StreamOrchestrator] 💰 Usage from finish-step: ` +
              `${usage.totalTokens || 0} total ` +
              `(${usage.inputTokens || 0} input + ${usage.outputTokens || 0} output)`,
          );

          // Yield a done chunk with usage for AgentService to capture
          yield createChatStreamChunk(
            "done",
            {
              usage: {
                promptTokens: usage.inputTokens || 0,
                completionTokens: usage.outputTokens || 0,
                totalTokens: usage.totalTokens || 0,
              },
            },
            chatId,
          );
        }

        const finishReason = finishStepChunk.finishReason;
        if (finishReason === "length") {
          console.warn(
            `[StreamOrchestrator] ⚠️ Model stopped due to TOKEN LIMIT! Consider increasing maxTokens.`,
          );
        }
        break;
      }

      case "finish": {
        const finishReason = (rawChunk as any).finishReason;
        console.log(
          `[StreamOrchestrator] 🏁 Finish chunk received, reason: ${finishReason || "unknown"}`,
        );
        break;
      }
      default:
        break;
    }
  }

  // Flush any remaining tool results (e.g. stream ended after last tool-result)
  yield* flushToolResultBuffer();

  if (textBuffer.length > 0) {
    yield createChatStreamChunk("text-delta", { text: textBuffer }, chatId);
  }
  if (reasoningBuffer.length > 0) {
    yield createChatStreamChunk(
      "reasoning-delta",
      { text: reasoningBuffer },
      chatId,
    );
  }

  // Add any remaining text segment to sequence (final text after all tools)
  if (currentTextSegment.trim()) {
    sequence.push({ type: "text", data: currentTextSegment.trim() });
  }

  console.log(
    `[StreamOrchestrator] Chat ${chatId}: Stream complete - Text: ${(assistantText.length / 1000).toFixed(0)}KB, Thinking: ${(thinkingText.length / 1000).toFixed(0)}KB`,
  );

  return {
    assistantText,
    thinkingText,
    toolCalls,
    toolResults,
    sequence, // Return V1-style sequence for interleaving
  };
}
