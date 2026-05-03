import {
  sanitizeToolOutput,
} from "../../../core/tools/index.js";
import {
  createChatStreamChunk,
  parseToolCallChunk,
  parseToolErrorChunk,
  parseToolResultChunk,
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
 * Extract the underlying error from an AI SDK RetryError.
 * RetryError wraps an array of APICallError instances from each retry attempt.
 * We extract the last (most relevant) error's status code and message.
 */
function extractFromRetryError(error: Record<string, unknown>): string | null {
  const errors = error.errors as Array<unknown> | undefined;
  const lastError = error.lastError as Record<string, unknown> | undefined;
  
  const underlying = lastError ?? (Array.isArray(errors) ? errors[errors.length - 1] : undefined);
  if (!underlying || typeof underlying !== "object") return null;
  
  const err = underlying as Record<string, unknown>;
  const statusCode = err.statusCode as number | undefined;
  const message = typeof err.message === "string" ? err.message : undefined;
  const responseBody = typeof err.responseBody === "string" ? err.responseBody : undefined;

  // Try to extract Anthropic's error type from response body (e.g. "overloaded_error")
  let apiErrorType: string | undefined;
  if (responseBody) {
    try {
      const body = JSON.parse(responseBody) as Record<string, unknown>;
      const bodyError = body.error as Record<string, unknown> | undefined;
      if (bodyError && typeof bodyError.type === "string") {
        apiErrorType = bodyError.type;
      }
      if (bodyError && typeof bodyError.message === "string" && !message) {
        return `API error${statusCode ? ` (${statusCode})` : ""}: ${bodyError.message}`;
      }
    } catch {
      // Response body not JSON
    }
  }

  if (statusCode === 529 || apiErrorType === "overloaded_error") {
    return "Claude servers are temporarily overloaded. Please wait a moment and try again, or switch to a different model.";
  }
  if (statusCode === 429) {
    return "Rate limit exceeded. Please wait a moment and try again.";
  }
  if (statusCode === 401) {
    return "Invalid API key. Please check your Anthropic API key in Settings.";
  }
  if (statusCode === 403) {
    return "API key does not have permission for this model. Check your Anthropic plan.";
  }
  if (statusCode === 402) {
    return "Credit balance too low. Please add credits to your Anthropic account.";
  }
  if (statusCode && statusCode >= 500) {
    return `Anthropic server error (${statusCode}). Please try again in a moment.`;
  }
  if (message) {
    return `API error${statusCode ? ` (${statusCode})` : ""}: ${message}`;
  }
  return null;
}

/**
 * Extract a user-friendly error message from API errors.
 * Handles AI SDK RetryError (with nested APICallError), plain Error objects,
 * and common API error response shapes.
 */
function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const errorObj = error as Record<string, unknown>;

    // AI SDK RetryError: has `reason` and `errors` array with underlying APICallErrors
    if (
      errorObj.reason === "maxRetriesExceeded" ||
      errorObj.reason === "errorNotRetryable" ||
      (errorObj.name === "AI_RetryError" || errorObj.name === "RetryError") ||
      (Array.isArray(errorObj.errors) && errorObj.lastError !== undefined)
    ) {
      const extracted = extractFromRetryError(errorObj);
      if (extracted) return extracted;
    }

    // AI SDK APICallError: has statusCode and url
    if (typeof errorObj.statusCode === "number" && typeof errorObj.url === "string") {
      const statusCode = errorObj.statusCode as number;
      const message = typeof errorObj.message === "string" ? errorObj.message : "";
      if (statusCode === 529) {
        return "Claude servers are temporarily overloaded. Please wait a moment and try again.";
      }
      if (statusCode === 429) {
        return "Rate limit exceeded. Please wait a moment and try again.";
      }
      if (statusCode === 401) {
        return "Invalid API key. Please check your API key in Settings.";
      }
      return `API error (${statusCode}): ${message}`;
    }

    // Claude API error format: { error: { type: "api_error", message: "Internal Server Error", details: {...} } }
    if (
      typeof errorObj.error === "object" &&
      errorObj.error !== null
    ) {
      const errorDetails = errorObj.error as Record<string, unknown>;
      
      // Check for Claude's error structure with message
      if (typeof errorDetails.message === "string") {
        const errorMessage = errorDetails.message;
        const errorType = typeof errorDetails.type === "string" ? errorDetails.type : "";
        
        // Handle "Internal Server Error" from Claude
        if (errorMessage === "Internal Server Error" || errorType === "api_error") {
          return "🔄 Claude's servers encountered an internal error. This is a temporary issue on Anthropic's side. Please try again in a moment, or switch to a different model.";
        }
        
        // Handle other overloaded errors
        if (errorType === "overloaded_error" || errorMessage.includes("overloaded")) {
          return "Claude servers are temporarily overloaded. Please wait a moment and try again, or switch to a different model.";
        }
        
        // Return the error message with type if available
        return errorType ? `${errorType}: ${errorMessage}` : errorMessage;
      }
    }

    // Plain Error object
    if (error instanceof Error) {
      // Check if it's a retry error by name (cross-realm instances)
      if (error.name === "AI_RetryError" || error.name === "RetryError") {
        const extracted = extractFromRetryError(errorObj);
        if (extracted) return extracted;
      }
      return error.message;
    }

    // { message: "..." }
    if (typeof errorObj.message === "string") {
      return errorObj.message;
    }

    // { data: { error: { message: "..." } } }
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

    try {
      return JSON.stringify(errorObj);
    } catch {
      return "[Unserializable error object]";
    }
  }

  // instanceof check for errors not caught above (e.g., non-object realms)
  if (error instanceof Error) {
    return error.message;
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
    // No truncation here — all results pass through at full size.
    // Stale results are compacted in prepareStep before the next model call.
    for (let i = 0; i < toolResultBuffer.length; i++) {
      const item = toolResultBuffer[i];
      const toolResult: ToolResultEvent = {
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        result: item.result,
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

        const isToolError =
          sanitizedResult &&
          typeof sanitizedResult === "object" &&
          "error" in (sanitizedResult as Record<string, unknown>);
        import("../gatewayTelemetry.js").then(({ getGatewayTelemetry }) => {
          getGatewayTelemetry().trackFireAndForget("paprwork_tool_called", {
            tool_name: parsedToolResult.toolName,
            success: !isToolError,
            result_size: rawSize,
            chat_id: chatId,
          });
        }).catch(() => {});

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
        // IMPORTANT: Don't yield "done" here - that would trigger frontend to finalize
        // and create a new message for the next step! Only yield "done" on final "finish".
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

          // Yield a step-usage chunk (NOT "done") for AgentService to capture
          // This prevents frontend from finalizing prematurely
          yield createChatStreamChunk(
            "step-usage",
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
        const finishChunk = rawChunk as any;
        const finishReason = finishChunk.finishReason;
        const usage = finishChunk.usage;
        
        console.log(
          `[StreamOrchestrator] 🏁 Finish chunk received, reason: ${finishReason || "unknown"}`,
        );
        
        // If we have token usage from the model, yield it as a step-usage chunk
        // so AgentService can use it for summarization decisions
        if (usage?.promptTokens) {
          console.log(
            `[StreamOrchestrator] 💰 Token usage from model: ${usage.totalTokens || 0} total ` +
            `(${usage.promptTokens} prompt + ${usage.completionTokens || 0} completion)`,
          );
          yield createChatStreamChunk(
            "step-usage",
            { usage },
            chatId,
          );
        }
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
