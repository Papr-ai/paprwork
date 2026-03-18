/**
 * Pi Codex Stream with Tool Loop - Multi-turn tool execution for pi-ai openai-codex
 *
 * When the model returns tool calls (done with reason: toolUse), we:
 * 1. Execute each tool
 * 2. Add assistant message + tool results to context
 * 3. Call streamSimple again
 * 4. Repeat until we get stop/length or hit maxSteps
 */

import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import {
  sanitizeToolOutput,
  truncateResult,
} from "../../../core/tools/index.js";

type ToolCallAccum = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
};

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
  | { type: "start-step" }
  | { type: "error"; error: unknown };

/**
 * Coerce arg types that models commonly get wrong:
 * - Numeric strings → numbers ("5" → 5)
 * - Stringified JSON arrays/objects → parsed values
 * Applied before Mastra validation so tools don't silently fail.
 */
function coerceArgTypes(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      // "123" or "0" → number (but not "" or "hello")
      if (/^-?\d+(\.\d+)?$/.test(value)) {
        result[key] = Number(value);
        continue;
      }
      // "true"/"false" → boolean
      if (value === "true" || value === "false") {
        result[key] = value === "true";
        continue;
      }
    }
    result[key] = value;
  }
  return result;
}

/**
 * Execute a single tool call using Mastra tools
 * @param skipTruncation - When true (last tool in step), return full result for model context
 */
async function executeToolCall(
  toolCall: ToolCallAccum,
  mastraTools: Record<
    string,
    { execute?: (args: unknown) => Promise<unknown> }
  >,
  apiKeys: string[],
  skipTruncation: boolean = false,
): Promise<{ toolCallId: string; toolName: string; result: unknown }> {
  const tool = mastraTools[toolCall.toolName];
  if (!tool?.execute) {
    return {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      result: { error: `Tool not found: ${toolCall.toolName}` },
    };
  }
  try {
    const rawResult = await tool.execute(coerceArgTypes(toolCall.args));

    // Detect Mastra validation errors (returned as result, not thrown)
    if (
      rawResult &&
      typeof rawResult === "object" &&
      (rawResult as Record<string, unknown>).error === true &&
      typeof (rawResult as Record<string, unknown>).message === "string"
    ) {
      const msg = (rawResult as Record<string, unknown>).message as string;
      console.warn(
        `[PiCodexToolLoop] ⚠️ Mastra validation error for ${toolCall.toolName}: ${msg}`,
      );
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result: { error: msg },
      };
    }

    const sanitized = sanitizeToolOutput(rawResult, apiKeys);
    const result =
      typeof sanitized === "string" && !skipTruncation
        ? truncateResult(sanitized)
        : sanitized && typeof sanitized === "object"
          ? sanitized
          : sanitized;
    return {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      result,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      result: { error: errorMsg },
    };
  }
}

/**
 * Add assistant message and tool results to pi-ai context with adaptive truncation
 * Matches the truncation strategy from AI SDK's prepareStep
 */
function appendToolTurnToContext(
  context: { messages: unknown[] },
  assistantMessage: {
    content: unknown[];
    api: string;
    provider: string;
    model: string;
    usage: unknown;
    stopReason: string;
    timestamp: number;
  },
  toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }>,
  cumulativeTokens: number,
): void {
  context.messages.push(assistantMessage);
  const now = Date.now();

  // Adaptive truncation based on context pressure (matching AI SDK's prepareStep logic)
  const CONTEXT_PRESSURE_THRESHOLDS = {
    low: 30000,
    medium: 60000,
    high: 90000,
  };

  let pressureLevel: "low" | "medium" | "high";
  if (cumulativeTokens < CONTEXT_PRESSURE_THRESHOLDS.low) {
    pressureLevel = "low";
  } else if (cumulativeTokens < CONTEXT_PRESSURE_THRESHOLDS.medium) {
    pressureLevel = "medium";
  } else {
    pressureLevel = "high";
  }

  // Determine truncation limits based on pressure
  const getTruncationLimit = (): number | null => {
    if (pressureLevel === "low") {
      return 12000; // 3000 tokens
    } else if (pressureLevel === "medium") {
      return 8000; // 2000 tokens
    } else {
      return 4000; // 1000 tokens
    }
  };

  const maxLength = getTruncationLimit();

  for (const tr of toolResults) {
    let text =
      typeof tr.result === "string"
        ? tr.result
        : JSON.stringify(tr.result ?? "");

    // Apply truncation if needed
    const EMERGENCY_LIMIT = 200000; // ~50K tokens
    if (text.length > EMERGENCY_LIMIT) {
      const truncated = text.substring(0, EMERGENCY_LIMIT);
      const omitted = text.length - EMERGENCY_LIMIT;
      console.warn(
        `[PiCodexToolLoop] ⚠️ EMERGENCY truncation: tool result was ${Math.round(text.length / 1024)}KB, ` +
          `truncated to ${Math.round(EMERGENCY_LIMIT / 1024)}KB`,
      );
      text =
        truncated +
        `\n\n[⚠️ EMERGENCY TRUNCATION: Result was ${Math.round(text.length / 1024)}KB (${Math.round(text.length / 4000)}K tokens), ` +
        `truncated ${omitted} chars. This is too large for context. ` +
        `Use more specific search patterns or incremental reading.]`;
    } else if (maxLength && text.length > maxLength) {
      const truncated = text.substring(0, maxLength);
      const omitted = text.length - maxLength;
      const estimatedTokens = Math.ceil(maxLength / 4);
      text =
        truncated +
        `\n\n[... ${omitted} chars truncated (context: ${Math.round(cumulativeTokens / 1000)}K/${pressureLevel}, ` +
        `limit: ~${estimatedTokens} tokens)]`;
    }

    const resultObj = tr.result && typeof tr.result === "object" ? tr.result as Record<string, unknown> : null;
    const isError = resultObj
      ? resultObj.success === false || typeof resultObj.error === "string"
      : false;

    context.messages.push({
      role: "toolResult",
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      content: [{ type: "text" as const, text }],
      isError,
      timestamp: now,
    });
  }
}

/**
 * Create a stream that runs multiple pi-ai turns when the model returns tool calls
 * Now includes context pressure monitoring and auto-summarization
 */
export async function* createPiCodexStreamWithToolLoop(
  streamSimple: (
    model: unknown,
    context: unknown,
    options: unknown,
  ) => AsyncIterable<AssistantMessageEvent>,
  piModel: unknown,
  initialContext: {
    systemPrompt?: string;
    messages: unknown[];
    tools?: unknown[];
  },
  streamOptions: {
    apiKey: string;
    sessionId: string;
    signal?: AbortSignal;
    reasoning?: string;
  },
  mastraTools: Record<
    string,
    { execute?: (args: unknown) => Promise<unknown> }
  >,
  apiKeys: string[],
  maxSteps: number,
  onContextPressure?: () => Promise<void>, // Callback to trigger summarization
): AsyncGenerator<OurChunk> {
  const context = {
    ...initialContext,
    messages: [...initialContext.messages],
  };

  let step = 0;
  let cumulativeTokens = 0; // Track token usage for adaptive truncation
  const CONTEXT_ABORT_THRESHOLD = 120000; // Same as AI SDK path

  // Estimate initial context tokens
  const initialContextStr = JSON.stringify(context.messages);
  cumulativeTokens = Math.ceil(initialContextStr.length / 4);

  console.log(
    `[PiCodexToolLoop] Starting with ~${Math.round(cumulativeTokens / 1000)}K tokens`,
  );

  while (step < maxSteps) {
    // Check context pressure before each step
    if (cumulativeTokens > CONTEXT_ABORT_THRESHOLD) {
      console.warn(
        `[PiCodexToolLoop] ⚠️ Context pressure at step ${step}: ` +
          `${cumulativeTokens} tokens > ${CONTEXT_ABORT_THRESHOLD} threshold. ` +
          `Aborting stream and triggering compression.`,
      );

      // Yield error to trigger summarization in parent
      yield {
        type: "error",
        error: {
          type: "context_length_exceeded",
          message:
            "Context limit approaching. Conversation will be summarized automatically.",
        },
      };

      // Trigger summarization callback if provided
      if (onContextPressure) {
        await onContextPressure();
      }

      break; // Stop loop - parent will handle retry with compressed context
    }

    if (step > 0) {
      yield { type: "start-step" };
    }

    const piStream = streamSimple(piModel, context, streamOptions);
    const toolCallsThisTurn: ToolCallAccum[] = [];
    let lastFinishReason: string | null = null;
    let finalMessage: {
      content: unknown[];
      api: string;
      provider: string;
      model: string;
      usage: unknown;
      stopReason: string;
      timestamp: number;
    } | null = null;

    for await (const event of piStream) {
      if (event.type === "toolcall_end" && event.toolCall) {
        toolCallsThisTurn.push({
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
          args: event.toolCall.arguments ?? {},
        });
      }
      if (event.type === "done") {
        lastFinishReason =
          event.reason === "toolUse"
            ? "tool-calls"
            : event.reason === "length"
              ? "length"
              : "stop";
        finalMessage = event.message as any;

        // Extract token usage if available
        const usage = (event as any).usage;
        if (usage?.input_tokens) {
          cumulativeTokens = usage.input_tokens;
          console.log(
            `[PiCodexToolLoop] Step ${step}: ${Math.round(cumulativeTokens / 1000)}K tokens used`,
          );
        }

        // Don't yield "finish" when toolUse - we're continuing the loop
        if (event.reason === "toolUse") continue;
      }

      const chunk = adaptPiStreamToAISDKEvent(event);
      if (chunk) yield chunk;
    }

    if (
      lastFinishReason === "tool-calls" &&
      toolCallsThisTurn.length > 0 &&
      finalMessage
    ) {
      // Execute tools - keep last result full for model context
      const lastIdx = toolCallsThisTurn.length - 1;
      const toolResults = await Promise.all(
        toolCallsThisTurn.map((tc, i) =>
          executeToolCall(tc, mastraTools, apiKeys, i === lastIdx),
        ),
      );

      for (const tr of toolResults) {
        yield {
          type: "tool-result",
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          result: tr.result,
        };
      }

      // Append with adaptive truncation based on context pressure
      appendToolTurnToContext(context, finalMessage, toolResults, cumulativeTokens);

      // Update cumulative tokens with estimated added context
      const addedContext = toolResults
        .map((tr) =>
          typeof tr.result === "string"
            ? tr.result
            : JSON.stringify(tr.result ?? ""),
        )
        .join("");
      cumulativeTokens += Math.ceil(addedContext.length / 4);

      step++;
      console.log(
        `[PiCodexToolLoop] Step ${step}: executed ${toolCallsThisTurn.length} tools, ` +
          `cumulative context: ~${Math.round(cumulativeTokens / 1000)}K tokens`,
      );
    } else {
      // Done - no more tool turns
      break;
    }
  }
}

/**
 * Adapt a single pi-ai event to OurChunk (same logic as PiToAISDKAdapter but for one event)
 */
function adaptPiStreamToAISDKEvent(
  event: AssistantMessageEvent,
): OurChunk | null {
  switch (event.type) {
    case "text_delta": {
      const delta = event.delta;
      if (typeof delta === "string" && delta.length > 0) {
        return { type: "text-delta", text: delta };
      }
      return null;
    }
    case "thinking_start":
      return { type: "reasoning-start" };
    case "thinking_delta": {
      const delta = event.delta;
      if (typeof delta === "string" && delta.length > 0) {
        return { type: "reasoning-delta", text: delta };
      }
      return null;
    }
    case "thinking_end":
      return { type: "reasoning-end" };
    case "toolcall_end": {
      const toolCall = event.toolCall;
      if (toolCall) {
        return {
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments ?? {},
        };
      }
      return null;
    }
    case "done": {
      const reason = event.reason ?? "stop";
      const finishReason =
        reason === "toolUse"
          ? "tool-calls"
          : reason === "length"
            ? "length"
            : "stop";
      return { type: "finish", finishReason };
    }
    case "error":
      return {
        type: "error",
        error:
          (event as { error?: { errorMessage?: string } }).error
            ?.errorMessage ?? event,
      };
    default:
      return null;
  }
}
