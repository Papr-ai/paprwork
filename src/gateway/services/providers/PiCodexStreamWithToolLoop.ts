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
    const rawResult = await tool.execute(toolCall.args);
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
 * Add assistant message and tool results to pi-ai context
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
): void {
  context.messages.push(assistantMessage);
  const now = Date.now();
  for (const tr of toolResults) {
    const text =
      typeof tr.result === "string"
        ? tr.result
        : JSON.stringify(tr.result ?? "");
    context.messages.push({
      role: "toolResult",
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      content: [{ type: "text" as const, text }],
      isError: false,
      timestamp: now,
    });
  }
}

/**
 * Create a stream that runs multiple pi-ai turns when the model returns tool calls
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
): AsyncGenerator<OurChunk> {
  const context = {
    ...initialContext,
    messages: [...initialContext.messages],
  };

  let step = 0;
  while (step < maxSteps) {
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

      appendToolTurnToContext(context, finalMessage, toolResults);
      step++;
      console.log(
        `[PiCodexToolLoop] Step ${step}: executed ${toolCallsThisTurn.length} tools, continuing...`,
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
