import { sanitizeToolOutput } from "../../../core/tools/index.js";
import { isFailedToolResult } from "../../../core/utils/interruptedToolResult.js";
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

/** True when the turn ends on tool call(s) with no user-visible text after them. */
export function sequenceEndsWithToolWithoutTrailingText(
  sequence: Array<{ type: string; data: unknown }>,
): boolean {
  if (sequence.length === 0) {
    return false;
  }

  let lastToolIndex = -1;
  for (let i = sequence.length - 1; i >= 0; i--) {
    if (sequence[i]?.type === "tool") {
      lastToolIndex = i;
      break;
    }
  }
  if (lastToolIndex < 0) {
    return false;
  }

  for (let i = lastToolIndex + 1; i < sequence.length; i++) {
    const item = sequence[i];
    if (
      item?.type === "text" &&
      typeof item.data === "string" &&
      item.data.trim().length > 0
    ) {
      return false;
    }
  }

  return true;
}

const NETWORK_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const NETWORK_ERROR_NAMES = new Set([
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "AbortError",
  "APIConnectionTimeoutError",
]);

function walkErrorChain(error: unknown, depth = 0): unknown[] {
  if (depth > 6 || error == null) return [];
  const chain: unknown[] = [error];
  if (typeof error !== "object") return chain;

  const record = error as Record<string, unknown>;
  if (record.cause !== undefined) {
    chain.push(...walkErrorChain(record.cause, depth + 1));
  }
  if (record.lastError !== undefined) {
    chain.push(...walkErrorChain(record.lastError, depth + 1));
  }
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      chain.push(...walkErrorChain(nested, depth + 1));
    }
  }
  return chain;
}

function extractRequestUrl(error: unknown): string | undefined {
  for (const node of walkErrorChain(error)) {
    if (typeof node !== "object" || node === null) continue;
    const url = (node as Record<string, unknown>).url;
    if (typeof url === "string" && url.startsWith("http")) {
      return url;
    }
  }
  return undefined;
}

function describeNetworkTarget(url: string | undefined): string {
  if (!url) return "the AI provider";
  try {
    const host = new URL(url).hostname;
    if (host === "memory.papr.ai") {
      return "Papr's AI service (memory.papr.ai)";
    }
    return host;
  } catch {
    return "the AI provider";
  }
}

function isNetworkConnectivityError(error: unknown): boolean {
  for (const node of walkErrorChain(error)) {
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    const code = record.code;
    const name = record.name;
    const message =
      typeof record.message === "string" ? record.message.toLowerCase() : "";

    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
      return true;
    }
    if (typeof name === "string" && NETWORK_ERROR_NAMES.has(name)) {
      return true;
    }
    if (
      message.includes("connect timeout") ||
      message.includes("connection timed out") ||
      message.includes("fetch failed") ||
      message.includes("request timed out") ||
      message.includes("api connection timeout") ||
      message.includes("network error")
    ) {
      return true;
    }
  }
  return false;
}

function formatNetworkConnectivityMessage(error: unknown): string {
  const target = describeNetworkTarget(extractRequestUrl(error));
  return (
    `Could not connect to ${target}. The request timed out after several retries. ` +
    "Check your internet connection, VPN, or firewall, then try again. " +
    "If the problem persists, switch to a different model or try again in a few minutes."
  );
}

/**
 * Extract the underlying error from an AI SDK RetryError.
 * RetryError wraps an array of APICallError instances from each retry attempt.
 * We extract the last (most relevant) error's status code and message.
 */
function extractFromRetryError(error: Record<string, unknown>): string | null {
  if (isNetworkConnectivityError(error)) {
    return formatNetworkConnectivityMessage(error);
  }

  const errors = error.errors as Array<unknown> | undefined;
  const lastError = error.lastError as Record<string, unknown> | undefined;
  
  const underlying = lastError ?? (Array.isArray(errors) ? errors[errors.length - 1] : undefined);
  if (!underlying || typeof underlying !== "object") return null;

  if (isNetworkConnectivityError(underlying)) {
    return formatNetworkConnectivityMessage(error);
  }
  
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
 * Extract a machine-readable error code when present (e.g. rate_limit_exhausted).
 */
function extractErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const errorObj = error as Record<string, unknown>;

  if (typeof errorObj.code === "string") {
    return errorObj.code;
  }

  if (typeof errorObj.error === "object" && errorObj.error !== null) {
    const nested = errorObj.error as Record<string, unknown>;
    if (typeof nested.code === "string") {
      return nested.code;
    }
  }

  return undefined;
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

  if (isNetworkConnectivityError(error)) {
    return formatNetworkConnectivityMessage(error);
  }

  if (typeof error === "object" && error !== null) {
    const errorObj = error as Record<string, unknown>;

    if (
      errorObj.type === "stream_pause" &&
      typeof errorObj.message === "string"
    ) {
      return errorObj.message;
    }

    // AI SDK RetryError: has `reason` and `errors` array with underlying APICallErrors
    if (
      errorObj.reason === "maxRetriesExceeded" ||
      errorObj.reason === "errorNotRetryable" ||
      (errorObj.name === "AI_RetryError" || errorObj.name === "RetryError") ||
      (Array.isArray(errorObj.errors) && errorObj.lastError !== undefined)
    ) {
      const extracted = extractFromRetryError(errorObj);
      if (extracted) return extracted;
      if (errorObj.reason === "maxRetriesExceeded") {
        return (
          "The AI request failed after several retries. " +
          "Please wait a moment and try again, or switch to a different model."
        );
      }
    }

    // AI SDK APICallError without HTTP status (often network-level failures)
    if (typeof errorObj.url === "string" && typeof errorObj.statusCode !== "number") {
      if (isNetworkConnectivityError(errorObj)) {
        return formatNetworkConnectivityMessage(errorObj);
      }
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
      
      // Check for error structure with message (from any provider)
      if (typeof errorDetails.message === "string") {
        const errorMessage = errorDetails.message;
        const errorType = typeof errorDetails.type === "string" ? errorDetails.type : "";
        
        // Handle "Internal Server Error" from any provider
        if (errorMessage === "Internal Server Error" || errorType === "api_error") {
          return "🔄 The AI provider encountered an internal server error. This is a temporary issue on their side. Please try again in a moment, or switch to a different model.";
        }
        
        // Handle overloaded errors
        if (errorType === "overloaded_error" || errorMessage.includes("overloaded")) {
          return "The AI servers are temporarily overloaded. Please wait a moment and try again, or switch to a different model.";
        }

        if (errorType === "rate_limit_error" || errorMessage.toLowerCase().includes("rate limited")) {
          return "Rate limit exceeded. Please wait a moment and try again.";
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

    if (errorObj.name === "AI_RetryError" || errorObj.name === "RetryError") {
      return (
        "The AI request failed after several retries. " +
        "Please wait a moment and try again, or switch to a different model."
      );
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
  streamOptions?: { textBufferMin?: number },
): AsyncGenerator<ChatStreamChunk, StreamOrchestratorResult> {
  const TEXT_BUFFER_MIN = streamOptions?.textBufferMin ?? 50;
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

  // Buffer tool results so we can flush them together at turn boundaries.
  // NOTE: Results are yielded at FULL size — truncation of stale results across
  // turns is handled by compactStaleToolResults() before the next model call.
  // Truncating here would clobber parallel batch results on first sight (the
  // pre-refactor "i < lastIdx" bug).
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
    for (let i = 0; i < toolResultBuffer.length; i++) {
      const item = toolResultBuffer[i];
      const result = item.result;
      const failed = isFailedToolResult(result);
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
            status: failed ? "error" : "success",
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
          success: !failed,
          ...(failed && typeof result === "object" && result !== null
            ? {
                error:
                  typeof (result as Record<string, unknown>).error === "string"
                    ? ((result as Record<string, unknown>).error as string)
                    : "Tool call failed",
              }
            : {}),
        },
        chatId,
      );
    }
    toolResultBuffer.length = 0;
  }

  // Guarantee buffered tool results land in toolResults[] even if the
  // for-await throws or the generator gets `.return()`'d on abort. Without
  // this, parallel bash tool results that arrived just before the
  // interruption would be silently dropped, and on the next turn
  // historyFormatter would see orphaned tool-calls with no matching
  // results — feeding the model an empty string and breaking causality.
  const drainBufferIntoToolResults = () => {
    if (toolResultBuffer.length === 0) return;
    for (const item of toolResultBuffer) {
      // No truncation here — finally-path means we never got the chance to
      // do per-position truncation. Better to have the full result land in
      // toolResults than lose it entirely.
      toolResults.push({
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        result: item.result,
      });
    }
    toolResultBuffer.length = 0;
  };

  try {
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
        const errorCode = extractErrorCode(sanitizedError);
        console.error(
          `[StreamOrchestrator] Model error for chat ${chatId}: ${errorMessage}`,
        );
        yield createChatStreamChunk(
          "error",
          { error: errorMessage, ...(errorCode ? { code: errorCode } : {}) },
          chatId,
        );
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
            inputTokenDetails?: {
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
            };
            cachedInputTokens?: number;
          };
          providerMetadata?: {
            anthropic?: {
              cacheCreationInputTokens?: number;
              cacheReadInputTokens?: number;
            };
          };
          finishReason?: string;
        };

        if (finishStepChunk.usage) {
          const usage = finishStepChunk.usage;
          const { extractCacheUsageFromUsage } = await import(
            "./promptCacheControl.js"
          );
          const cache = extractCacheUsageFromUsage({
            inputTokenDetails: usage.inputTokenDetails,
            cachedInputTokens: usage.cachedInputTokens,
            providerMetadata: finishStepChunk.providerMetadata,
          });
          console.log(
            `[StreamOrchestrator] 💰 Usage from finish-step: ` +
              `${usage.totalTokens || 0} total ` +
              `(${usage.inputTokens || 0} input + ${usage.outputTokens || 0} output` +
              (cache.cacheReadTokens || cache.cacheWriteTokens
                ? `, cache read ${cache.cacheReadTokens} / write ${cache.cacheWriteTokens}`
                : "") +
              `)`,
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
                cacheReadTokens: cache.cacheReadTokens,
                cacheWriteTokens: cache.cacheWriteTokens,
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
        if (usage?.promptTokens || usage?.contextTokens) {
          console.log(
            `[StreamOrchestrator] 💰 Token usage from model: ${usage.totalTokens || 0} total ` +
              `(${usage.promptTokens} prompt + ${usage.completionTokens || 0} completion` +
              (usage.cacheReadTokens || usage.cacheWriteTokens
                ? `, cache read ${usage.cacheReadTokens ?? 0} / write ${usage.cacheWriteTokens ?? 0}`
                : "") +
              (usage.contextTokens
                ? `, context window: ${usage.contextTokens}`
                : "") +
              `)`,
          );
          yield createChatStreamChunk(
            "step-usage",
            {
              usage: {
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens ?? 0,
                totalTokens: usage.totalTokens ?? 0,
                cacheReadTokens: usage.cacheReadTokens,
                cacheWriteTokens: usage.cacheWriteTokens,
                contextTokens: usage.contextTokens,
              },
            },
            chatId,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  } finally {
    // Drain anything still buffered into toolResults so AgentService's
    // catch/saveMessage path persists them. Yields are not safe in finally
    // (would re-enter the generator), so we just push to the result array.
    drainBufferIntoToolResults();
  }

  // Flush any remaining tool results (e.g. stream ended after last tool-result)
  yield* flushToolResultBuffer();

  // ORPHAN-TOOL-CALL DETECTION
  // If the model emitted tool_use blocks but the stream ended before some of
  // them produced tool_results (e.g. the stream was aborted, the provider
  // returned `length` finish-reason mid-tool-call, or the network dropped),
  // synthesize an explicit "not persisted" result for each orphan. Without
  // this, the next turn's history shows tool_use with no matching result and
  // the model assumes silent success — exactly the failure mode that caused
  // the destructive-rm-then-failed-writes data loss bug.
  const resultIds = new Set(toolResults.map((r) => r.toolCallId));
  const orphans = toolCalls.filter((tc) => !resultIds.has(tc.toolCallId));
  if (orphans.length > 0) {
    console.warn(
      `[StreamOrchestrator] ⚠️ ${orphans.length} orphaned tool_use block(s) at stream end — synthesizing recovery markers so next turn retries`,
    );
    for (const tc of orphans) {
      const recoveryMarker = {
        __orphan: true as const,
        message:
          "[Tool result not persisted — likely the stream was interrupted before this tool finished. Treat as unknown; do not assume success or failure. Re-invoke if you need the data.]",
        toolName: tc.toolName,
      };
      toolResults.push({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result: recoveryMarker,
      });
      // Update sequence so the UI also shows the orphan state
      const idx = sequence.findIndex(
        (e) =>
          e.type === "tool" &&
          (e.data as { toolCallId?: string }).toolCallId === tc.toolCallId,
      );
      if (idx !== -1) {
        sequence[idx].data = {
          ...(sequence[idx].data as object),
          name: tc.toolName,
          input: tc.args,
          output: recoveryMarker,
          status: "interrupted",
          toolCallId: tc.toolCallId,
        };
      }
      yield createChatStreamChunk(
        "tool-result",
        {
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result: recoveryMarker,
          success: false,
        },
        chatId,
      );
    }
  }

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
