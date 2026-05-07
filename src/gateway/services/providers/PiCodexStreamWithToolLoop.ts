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
} from "../../../core/tools/index.js";
import { compactStaleToolResults, estimateMessagesTokens } from "../agent/compactToolResults.js";

/**
 * Truncate tool call ID to 64 characters (OpenAI's maximum length requirement).
 * IDs from various APIs may exceed this limit, causing validation errors.
 */
function truncateToolCallId(id: string): string {
  return id.length > 64 ? id.substring(0, 64) : id;
}

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
  | { type: "finish"; finishReason: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }
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
 
 */
async function executeToolCall(
  toolCall: ToolCallAccum,
  mastraTools: Record<
    string,
    { execute?: (args: unknown) => Promise<unknown> }
  >,
  apiKeys: string[],
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

    // Validate result exists (catch undefined/null from tool crashes/timeouts)
    if (rawResult === undefined || rawResult === null) {
      console.warn(
        `[PiCodexToolLoop] ⚠️ Tool ${toolCall.toolName} returned ${rawResult === null ? 'null' : 'undefined'} result - possible timeout or crash`,
      );
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result: { 
          success: false,
          error: `Tool returned no result (${rawResult === null ? 'null' : 'undefined'} - possible timeout or crash)`,
        },
      };
    }

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


    const result = sanitizeToolOutput(rawResult, apiKeys);


    import("../gatewayTelemetry.js").then(({ getGatewayTelemetry }) => {
      getGatewayTelemetry().trackFireAndForget("paprwork_tool_called", {
        tool_name: toolCall.toolName,
        success: true,
      });
    }).catch(() => {});

    return {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      result,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    import("../gatewayTelemetry.js").then(({ getGatewayTelemetry }) => {
      getGatewayTelemetry().trackFireAndForget("paprwork_tool_called", {
        tool_name: toolCall.toolName,
        success: false,
      });
    }).catch(() => {});

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
  _cumulativeTokens: number,
): void {
  context.messages.push(assistantMessage);
  const now = Date.now();

  for (const tr of toolResults) {
    let text =
      typeof tr.result === "string"
        ? tr.result
        : JSON.stringify(tr.result ?? "");

    // Warn if result is empty
    if (text === "" || text === '""' || text === "{}") {
      console.warn(
        `[PiCodexToolLoop] ⚠️ Tool ${tr.toolName} returned empty result.`,
      );
      text = `[Tool ${tr.toolName} returned empty result - possible timeout or crash]`;
    }

    const resultObj = tr.result && typeof tr.result === "object" ? tr.result as Record<string, unknown> : null;
    const isError = resultObj
      ? resultObj.success === false || typeof resultObj.error === "string"
      : false;

    // Store full results — compaction happens in compactStaleToolResults
    // before the next model call, not here.
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
  modelId?: string, // Add modelId to determine context threshold
): AsyncGenerator<OurChunk> {
  const context = {
    ...initialContext,
    messages: [...initialContext.messages],
  };

  let step = 0;
  let totalToolCalls = 0; // Track total tool calls across all steps
  let cumulativeTokens = 0; // Track token usage for adaptive truncation
  
  // Detect repetitive tool calls (possible infinite loop)
  const recentToolCalls: Array<{ name: string; args: string }> = [];
  const MAX_RECENT_TOOL_CALLS = 10;
  const REPETITION_THRESHOLD = 5; // If same tool called 5+ times recently, warn
  
  // Model-aware context thresholds (leave room for output + reasoning)
  // GPT-5.5: 1M context, but reasoning can be 30-50K → use 750K threshold (250K buffer)
  // GPT-5.4-mini: 272K context → use 200K threshold (72K buffer)
  // Claude Opus 4.7: 1M context → use 750K threshold (250K buffer)
  // Claude Opus 4.6: 200K context → use 120K threshold (conservative)
  // Default: 120K (conservative)
  const getContextThreshold = (): number => {
    if (!modelId) return 120000;
    
    // GPT-5.5 models (1M context) - includes legacy 5.4 non-mini variants
    if (modelId.startsWith('gpt-5.5') || 
        (modelId.startsWith('gpt-5.4') && modelId !== 'gpt-5.4-mini') ||
        modelId.startsWith('gpt-5.3') ||
        modelId.startsWith('gpt-5.2')) {
      return 750000; // 1M - 250K buffer for output + reasoning
    }
    
    // GPT-5.4-mini (272K context)
    if (modelId === 'gpt-5.4-mini') {
      return 200000; // 272K - 72K buffer
    }
    
    // Claude Opus 4.7 (1M context)
    if (modelId === 'claude-opus-4-7') {
      return 750000; // 1M - 250K buffer
    }
    
    // Claude models (200K context for older models)
    if (modelId.includes('claude')) {
      return 120000; // 200K - 80K buffer (conservative)
    }
    
    // Default conservative threshold
    return 120000;
  };
  
  const CONTEXT_ABORT_THRESHOLD = getContextThreshold();
  
  console.log(
    `[PiCodexToolLoop] Model: ${modelId || 'unknown'}, Context threshold: ${CONTEXT_ABORT_THRESHOLD.toLocaleString()} tokens`,
  );

  // Estimate initial context tokens
  const initialContextStr = JSON.stringify(context.messages);
  cumulativeTokens = Math.ceil(initialContextStr.length / 4);

  console.log(
    `[PiCodexToolLoop] Starting with ~${Math.round(cumulativeTokens / 1000)}K tokens`,
  );

  while (step < maxSteps) {
    // Estimate the size we'd ACTUALLY send (post-compaction) for the
    // threshold check. Cheap — just walks the array measuring strings.
    // Falls back to cumulativeTokens (last known prompt size) if no batches yet.
    if (step > 0) {
      const projectedTokens = estimateMessagesTokens(context.messages);
      if (projectedTokens < cumulativeTokens) {
        // Will compact; use the smaller projection
        cumulativeTokens = projectedTokens;
      }
    }
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


    // Compact stale tool results before sending to model.
    // Fresh batch (most recent) stays full; older batches get truncated.
    compactStaleToolResults(context.messages);

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
          toolCallId: truncateToolCallId(event.toolCall.id),
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

      const chunk = adaptPiStreamToAISDKEvent(event, cumulativeTokens);
      if (chunk) yield chunk;
    }

    if (
      lastFinishReason === "tool-calls" &&
      toolCallsThisTurn.length > 0 &&
      finalMessage
    ) {
      // Update total tool call counter
      totalToolCalls += toolCallsThisTurn.length;
      
      // Track recent tool calls to detect loops
      for (const tc of toolCallsThisTurn) {
        const argsStr = JSON.stringify(tc.args);
        recentToolCalls.push({ name: tc.toolName, args: argsStr });
      }
      if (recentToolCalls.length > MAX_RECENT_TOOL_CALLS) {
        recentToolCalls.splice(0, recentToolCalls.length - MAX_RECENT_TOOL_CALLS);
      }
      
      // Check for repetitive tool calls (same tool with similar args)
      const toolCallCounts = new Map<string, number>();
      for (const tc of recentToolCalls) {
        const key = `${tc.name}:${tc.args.substring(0, 100)}`; // First 100 chars of args
        toolCallCounts.set(key, (toolCallCounts.get(key) || 0) + 1);
      }
      
      const maxRepetitions = Math.max(...Array.from(toolCallCounts.values()));
      if (maxRepetitions >= REPETITION_THRESHOLD) {
        const repetitiveCall = Array.from(toolCallCounts.entries()).find(
          ([_, count]) => count === maxRepetitions
        );
        console.warn(
          `[PiCodexToolLoop] ⚠️ LOOP DETECTED: Tool call repeated ${maxRepetitions} times in last ${MAX_RECENT_TOOL_CALLS} calls. ` +
          `Call: ${repetitiveCall?.[0].substring(0, 80)}...`
        );
      }
      
      console.log(
        `[PiCodexToolLoop] Step ${step}: ${toolCallsThisTurn.length} tools this turn, ${totalToolCalls} total tool calls`
      );
      
      // Check tool result count in context for pressure warnings
      const toolResultCount = context.messages.filter(
        (m: any) => m.role === 'toolResult'
      ).length;
      
      if (toolResultCount > 100) {
        console.warn(
          `[PiCodexToolLoop] ⚠️ High tool result count: ${toolResultCount} results in context (${Math.round(cumulativeTokens / 1000)}K tokens). ` +
          `Performance may degrade.`
        );
      }
      
      if (toolResultCount > 200) {
        console.error(
          `[PiCodexToolLoop] 🚨 CRITICAL: ${toolResultCount} tool results in context (${Math.round(cumulativeTokens / 1000)}K tokens)! ` +
          `Recommend summarization or context reset.`
        );
      }
      
      // HARD LIMIT: Check total tool calls (not just steps)
      // Even if agent makes multiple tool calls per step, we enforce a hard limit
      const MAX_TOTAL_TOOL_CALLS = maxSteps * 2; // Allow 2x maxSteps as absolute maximum
      if (totalToolCalls >= MAX_TOTAL_TOOL_CALLS) {
        console.error(
          `[PiCodexToolLoop] 🛑 HARD LIMIT: ${totalToolCalls} tool calls exceeds maximum (${MAX_TOTAL_TOOL_CALLS}). ` +
          `Forcing stop to prevent infinite loops.`
        );
        
        // Add a system instruction to force a response
        context.messages.push({
          role: "user",
          content: `[SYSTEM: You've made ${totalToolCalls} tool calls, which exceeds the maximum limit of ${MAX_TOTAL_TOOL_CALLS}. You MUST stop making tool calls and provide your final response now. Summarize what you've learned and respond to the user.]`,
        } as any);
        
        break; // Force stop the loop
      }
      
      // Execute all tools in parallel — full results preserved for this turn.
      // Stale results from prior turns are compacted before the next model call.
      const toolResults = await Promise.all(
        toolCallsThisTurn.map((tc) =>
          executeToolCall(tc, mastraTools, apiKeys),
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

      // Check if approaching step limit
      const STEP_WARNING_THRESHOLD = 90;
      const STEP_FORCE_STOP_THRESHOLD = 95;
      
      if (step >= STEP_FORCE_STOP_THRESHOLD) {
        // Force stop at 95 steps - inject final instruction and break
        console.warn(
          `[PiCodexToolLoop] 🛑 Reached ${step} steps (force stop threshold). ` +
          `Breaking tool loop and forcing final response.`
        );
        
        // Add a system instruction as the last tool result to force a response
        context.messages.push({
          role: "user",
          content: `[SYSTEM: You've made ${step} tool calls. You MUST provide your final response now. Do not make any more tool calls. Summarize your findings and respond to the user.]`,
        } as any);
        
        break; // Force stop the loop
      } else if (step >= STEP_WARNING_THRESHOLD) {
        // At 90+ steps, warn the model
        console.warn(
          `[PiCodexToolLoop] ⚠️ Step ${step}/${maxSteps}: Approaching step limit. ` +
          `Model should wrap up soon.`
        );
        
        // Inject warning into the last tool result
        if (toolResults.length > 0) {
          const lastResult = toolResults[toolResults.length - 1];
          const warning = `\n\n[⚠️ Note: You've made ${step} tool calls out of ${maxSteps} maximum. Please wrap up and provide your response soon.]`;
          
          if (typeof lastResult.result === 'string') {
            lastResult.result += warning;
          } else if (lastResult.result && typeof lastResult.result === 'object') {
            (lastResult.result as any)._stepWarning = `Step ${step}/${maxSteps} - please wrap up`;
          }
        }
      }

      // Append full results — compaction happens in compactStaleToolResults
      // before the next model call (next loop iteration).
      appendToolTurnToContext(context, finalMessage, toolResults, cumulativeTokens);

      // Do NOT update cumulativeTokens here from raw context size — that
      // double-counts results that will be compacted before the next model call.
      // The next streamSimple() will set cumulativeTokens from usage.input_tokens
      // (line ~378), which reflects the COMPACTED prompt the model actually saw.
      // For the threshold check on the NEXT iteration we estimate post-compaction
      // size by simulating compaction on a clone (cheap — just walks the array).

      step++;
      console.log(
        `[PiCodexToolLoop] Step ${step}: executed ${toolCallsThisTurn.length} tools, ` +
          `cumulative context: ~${Math.round(cumulativeTokens / 1000)}K tokens, ` +
          `total tool calls: ${totalToolCalls}`,
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
  cumulativeTokens?: number,
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
          toolCallId: truncateToolCallId(toolCall.id),
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
      
      // Include token usage if available
      const usage = (event as any).usage;
      const promptTokens = usage?.input_tokens || cumulativeTokens || 0;
      const completionTokens = usage?.output_tokens || 0;
      
      return { 
        type: "finish", 
        finishReason,
        usage: promptTokens > 0 ? {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        } : undefined,
      };
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
