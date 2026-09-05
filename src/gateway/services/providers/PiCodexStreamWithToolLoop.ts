/**
 * Pi Codex Stream with Tool Loop - Multi-turn tool execution for pi-ai openai-codex
 *
 * When the model returns tool calls (done with reason: toolUse), we:
 * 1. Execute each tool
 * 2. Add assistant message + tool results to context
 * 3. Call streamSimple again
 * 4. Repeat until we get stop/length or hit maxSteps
 *
 * When pi-ai emits toolcall_end then done with reason stop/length (orphan drain),
 * pending tools are executed and the loop continues until the model is truly done.
 * After the stream finishes, AgentService may add a text-only summary if the
 * sequence ends on tool(s). Forced text-only steps (memory / limits) run in-loop.
 */

import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import {
  applyForcedTextOnlyWrapUpStep,
  applyPlanContinuationStep,
  WRAP_UP_AFTER_TOOLS_NO_TEXT,
} from "../agent/wrapUpContinuation.js";
import {
  sanitizeToolOutput,
} from "../../../core/tools/index.js";
import type { HistoryTrimBounds } from "../agent/midTurnContextTrim.js";
import {
  estimateMessagesTokens,
  stripAllAssistantReasoning,
} from "../agent/compactToolResults.js";
import {
  checkPiStreamMemory,
  PI_PROCESS_MEMORY_BACKSTOP_BYTES,
  PI_STREAM_MEMORY_BUDGET_BYTES,
} from "./piStreamMemoryLimits.js";
import {
  applyMidTurnContextShaping,
  resolvePiStreamMemoryLoopAction,
  type PiStreamMemoryLoopAction,
  WRAP_UP_AFTER_MEMORY_BUDGET,
} from "./piStreamMemoryWrapUp.js";
import {
  logPiStreamMemoryCheck,
  logPiTurnEnd,
  logWrapUpTrigger,
  type PiTurnEndReason,
} from "../agent/turnEndDiagnostics.js";
import { truncateToolResultForModelContext } from "../agent/toolResultTruncation.js";
import {
  EMPTY_PI_AI_BILLING_USAGE,
  accumulatePiAiBillingUsage,
  extractPiAiUsageFromDoneEvent,
  getPiAiContextTokensFromStep,
  type PiAiBillingUsage,
} from "./piAiUsage.js";
import {
  MAX_PROVIDER_RATE_LIMIT_RETRIES,
  computeRateLimitBackoffMs,
  createRateLimitExhaustedError,
  isRetryableProviderCapacityError,
  sleepMs,
} from "../../utils/providerRateLimitRetry.js";
/**
 * Truncate tool call ID to 64 characters (OpenAI's maximum length requirement).
 * IDs from various APIs may exceed this limit, causing validation errors.
 */
function yieldRateLimitExhausted(): { type: "error"; error: ReturnType<typeof createRateLimitExhaustedError> } {
  return { type: "error", error: createRateLimitExhaustedError() };
}

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
  | {
      type: "finish";
      finishReason: string;
      usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    }
  | { type: "start-step" }
  | { type: "error"; error: unknown };

/**
 * Coerce arg types that models commonly get wrong:
 * - Numeric strings → numbers ("5" → 5)
 * - Stringified JSON arrays/objects → parsed values
 * Applied before Mastra validation so tools don't silently fail.
 */
function tryParseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (
    !trimmed.startsWith("[") &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith('"')
  ) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

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
      // Stringified JSON arrays/objects → parsed values
      const parsed = tryParseJsonString(value);
      if (parsed !== value) {
        result[key] = parsed;
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
  toolContext: {
    chatId: string;
    jobEnv?: Record<string, string>;
    delegationJobId?: string;
  },
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
    const { runWithToolContext } = await import("../../../core/tools/context.js");
    const rawResult = await runWithToolContext(
      toolContext.chatId,
      () => tool.execute!(coerceArgTypes(toolCall.args)),
      {
        jobEnv: toolContext.jobEnv,
        delegationJobId: toolContext.delegationJobId,
      },
    );

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
        : safeStringify(tr.result ?? "");

    // Warn if result is empty
    if (text === "" || text === '""' || text === "{}") {
      console.warn(
        `[PiCodexToolLoop] ⚠️ Tool ${tr.toolName} returned empty result.`,
      );
      text = `[Tool ${tr.toolName} returned empty result - possible timeout or crash]`;
    }

    // Cap pathological results before adding to in-flight context.
    text = truncateToolResultForModelContext(
      text,
      tr.toolCallId,
      tr.toolName,
    );

    const resultObj = tr.result && typeof tr.result === "object" ? tr.result as Record<string, unknown> : null;
    const isError = resultObj
      ? resultObj.success === false || typeof resultObj.error === "string"
      : false;

    // Cap pathological results; full data remains in SQLite for get_full_tool_result.
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
 */
/**
 * Safe JSON serialization that handles circular references and errors
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_, val) => {
      // Handle circular references
      if (val && typeof val === 'object') {
        if (val[Symbol.for('__visited')]) {
          return '[Circular]';
        }
        val[Symbol.for('__visited')] = true;
      }
      return val;
    }, 2);
  } catch (err) {
    return `[Serialization failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

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
    cacheRetention?: "none" | "short" | "long";
    headers?: Record<string, string>;
    onPayload?: (
      params: Record<string, unknown>,
      model: unknown,
    ) =>
      | Record<string, unknown>
      | undefined
      | Promise<Record<string, unknown> | undefined>;
  },
  mastraTools: Record<
    string,
    { execute?: (args: unknown) => Promise<unknown> }
  >,
  apiKeys: string[],
  maxSteps: number,
  historyTrimBounds?: HistoryTrimBounds,
  toolContext?: {
    chatId: string;
    jobEnv?: Record<string, string>;
    delegationJobId?: string;
  },
  /**
   * Consulted when the model stops on its own. Returning a nudge keeps the loop
   * running with tools intact, which is how a turn that stopped mid-plan gets
   * resumed. Owned by AgentService so this layer stays free of PlanService.
   */
  resolveModelStop?: (info: {
    trailingText: string;
    step: number;
    totalToolCalls: number;
    continuationsUsed: number;
  }) => Promise<{ nudge: string; pendingSteps: number } | null>,
): AsyncGenerator<OurChunk> {
  const context = {
    ...initialContext,
    messages: [...initialContext.messages],
  };

  let step = 0;
  let totalToolCalls = 0; // Track total tool calls across all steps
  let cumulativeTokens = 0; // Track token usage for adaptive truncation
  let accumulatedBilling: PiAiBillingUsage = { ...EMPTY_PI_AI_BILLING_USAGE };
  
  // CIRCUIT BREAKER 1: Validation error tracking (Issue 65)
  let validationErrorCount = 0;
  const MAX_VALIDATION_ERRORS = 20; // Abort after 20 validation errors
  
  // Per-stream memory budget (baseline captured before context/tool accumulation)
  const baselineHeap = process.memoryUsage().heapUsed;

  /** One forced text-only step (memory budget or hard tool/step limits). */
  let textOnlyWrapUpStepUsed = false;

  // Detect repetitive tool calls (possible infinite loop)
  const recentToolCalls: Array<{ name: string; args: string }> = [];
  const MAX_RECENT_TOOL_CALLS = 10;
  const REPETITION_THRESHOLD = 5; // Same tool+args 5+ times in recent window → warn
  const REPETITION_ABORT_THRESHOLD = 8; // Hard abort on identical tool+args loops only

  // Fast char-based estimate — avoid JSON.stringify on 100K+ token contexts.
  cumulativeTokens = estimateMessagesTokens(context.messages);

  console.log(
    `[PiCodexToolLoop] Starting with ~${Math.round(cumulativeTokens / 1000)}K tokens ` +
      `(chatId=${toolContext?.chatId ?? "unknown"}, sessionId=${streamOptions.sessionId})`,
  );

  let turnEndLogged = false;
  let lastModelFinishReason: string | null = null;
  let streamedTextChars = 0;

  /** Text streamed during the current step — i.e. after the previous step's tools. */
  let stepText = "";
  let planContinuationsUsed = 0;

  const emitTurnEnd = (
    reason: PiTurnEndReason,
    extra?: {
      memoryCheck?: ReturnType<typeof checkPiStreamMemory>;
      memoryAction?: PiStreamMemoryLoopAction["kind"];
    },
  ): void => {
    if (turnEndLogged) {
      return;
    }
    turnEndLogged = true;
    logPiTurnEnd({
      chatId: toolContext?.chatId,
      sessionId: streamOptions.sessionId,
      reason,
      step,
      maxSteps,
      totalToolCalls,
      cumulativeTokens,
      modelFinishReason: lastModelFinishReason,
      textOnlyWrapUpUsed: textOnlyWrapUpStepUsed,
      validationErrorCount,
      memoryCheck: extra?.memoryCheck,
      memoryAction: extra?.memoryAction,
      assistantTextPreview:
        streamedTextChars > 0 ? `~${streamedTextChars} chars streamed to UI` : undefined,
    });
  };

  stepLoop: while (step < maxSteps) {
    // CIRCUIT BREAKER 1: Check validation error count (Issue 65)
    if (validationErrorCount >= MAX_VALIDATION_ERRORS) {
      console.error(
        `[PiCodexToolLoop] 🚨 CRITICAL: ${validationErrorCount} validation errors detected. ` +
        `Aborting to prevent infinite validation loop.`
      );
      yield {
        type: "error",
        error: {
          type: "validation_loop",
          message: `Too many validation errors (${validationErrorCount}). This usually indicates a schema mismatch or malformed data. Please refresh and try again.`,
        },
      };
      emitTurnEnd("validation_loop");
      break;
    }
    
    // CIRCUIT BREAKER 2: Per-stream + process backstop memory checks
    const memoryCheck = checkPiStreamMemory(baselineHeap);
    const memoryAction = resolvePiStreamMemoryLoopAction(
      memoryCheck,
      textOnlyWrapUpStepUsed,
    );

    logPiStreamMemoryCheck({
      chatId: toolContext?.chatId,
      step,
      check: memoryCheck,
      action: memoryAction,
    });

    if (memoryAction.kind === "process_error") {
      const streamMb = Math.round(memoryCheck.streamDelta / 1024 / 1024);
      const heapMb = Math.round(memoryCheck.heapUsed / 1024 / 1024);
      const budgetMb = Math.round(PI_STREAM_MEMORY_BUDGET_BYTES / 1024 / 1024);
      const backstopMb = Math.round(PI_PROCESS_MEMORY_BACKSTOP_BYTES / 1024 / 1024);
      console.error(
        `[PiCodexToolLoop] 🚨 CRITICAL: Process memory backstop exceeded — ` +
          `stream +${streamMb}MB (limit ${budgetMb}MB), process heap ${heapMb}MB ` +
          `(backstop ${backstopMb}MB). Aborting this stream.`,
      );
      yield {
        type: "error",
        error: {
          type: "process_memory_exhaustion",
          message:
            "The agent service is under heavy load (too many parallel tasks). " +
            "Try again shortly, restart the app, or stagger scheduled agent jobs.",
        },
      };
      emitTurnEnd("process_memory_error", {
        memoryCheck,
        memoryAction: memoryAction.kind,
      });
      break;
    }

    if (memoryAction.kind === "graceful_end") {
      console.warn(
        `[PiCodexToolLoop] Stream memory still high after wrap-up step ` +
          `(+${Math.round(memoryCheck.streamDelta / 1024 / 1024)}MB) — ending turn gracefully`,
      );
      emitTurnEnd("memory_graceful_end", {
        memoryCheck,
        memoryAction: memoryAction.kind,
      });
      break stepLoop;
    }

    let memoryPressure = false;
    if (memoryAction.kind === "force_wrap_up") {
      textOnlyWrapUpStepUsed = true;
      applyForcedTextOnlyWrapUpStep(context, WRAP_UP_AFTER_MEMORY_BUDGET);
      memoryPressure = true;
      logWrapUpTrigger({
        chatId: toolContext?.chatId,
        sessionId: streamOptions.sessionId,
        trigger: "memory_force_wrap_up",
        step,
        totalToolCalls,
        memoryCheck,
      });
      console.warn(
        `[PiCodexToolLoop] Stream memory budget exceeded ` +
          `(+${Math.round(memoryCheck.streamDelta / 1024 / 1024)}MB) — ` +
          `compacting context and forcing wrap-up summary (tools disabled)`,
      );
    } else {
      memoryPressure = memoryAction.memoryPressure;
      if (memoryPressure) {
        console.warn(
          `[PiCodexToolLoop] ⚠️ High stream memory: +${Math.round(memoryCheck.streamDelta / 1024 / 1024)}MB ` +
            `(process heap ${Math.round(memoryCheck.heapUsed / 1024 / 1024)}MB) — applying aggressive compaction`,
        );
      }
    }

    if (step > 0) {
      yield { type: "start-step" };
    }

    applyMidTurnContextShaping(
      context.messages,
      historyTrimBounds,
      memoryPressure,
      { skipStaleToolCompaction: step === 0 },
    );

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

    let stepStreamCompleted = false;
    let rateLimitAttempt = 0;

    while (!stepStreamCompleted) {
      toolCallsThisTurn.length = 0;
      lastFinishReason = null;
      finalMessage = null;
      stepText = "";

      let capacityError: unknown | null = null;
      let shouldRetryCapacity = false;

      try {
        let piStream: AsyncIterable<AssistantMessageEvent>;
        try {
          piStream = streamSimple(piModel, context, streamOptions);
        } catch (err) {
          if (isRetryableProviderCapacityError(err)) {
            if (rateLimitAttempt < MAX_PROVIDER_RATE_LIMIT_RETRIES) {
              capacityError = err;
              shouldRetryCapacity = true;
            } else {
              yield yieldRateLimitExhausted();
              emitTurnEnd("rate_limit_exhausted");
              return;
            }
          } else if (err && typeof err === "object" && "errors" in err) {
            validationErrorCount++;
            console.error(
              `[PiCodexToolLoop] ❌ Validation error #${validationErrorCount}: ${safeStringify(err)}`,
            );

            if (validationErrorCount >= MAX_VALIDATION_ERRORS) {
              console.error(
                `[PiCodexToolLoop] 🚨 CRITICAL: Reached ${MAX_VALIDATION_ERRORS} validation errors. Aborting.`,
              );
              yield {
                type: "error",
                error: {
                  type: "validation_loop",
                  message:
                    "Too many validation errors. This usually indicates a schema mismatch. Please refresh and try again.",
                },
              };
              emitTurnEnd("validation_loop");
              return;
            }

            stepStreamCompleted = true;
            continue stepLoop;
          } else {
            throw err;
          }
        }

        if (!shouldRetryCapacity) {
          for await (const event of piStream!) {
            if (event.type === "error") {
              const apiError =
                (event as { error?: unknown }).error ?? event;
              if (isRetryableProviderCapacityError(apiError)) {
                if (rateLimitAttempt < MAX_PROVIDER_RATE_LIMIT_RETRIES) {
                  capacityError = apiError;
                  shouldRetryCapacity = true;
                  break;
                }
                yield yieldRateLimitExhausted();
                emitTurnEnd("rate_limit_exhausted");
                return;
              }
            }

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
              lastModelFinishReason = lastFinishReason;
              finalMessage = event.message;

              const stepUsage = extractPiAiUsageFromDoneEvent(event);
              if (step === 1 && event.message?.usage) {
                console.log(
                  `[PiCodexToolLoop] Step 1 raw usage from API:`,
                  JSON.stringify(event.message.usage),
                );
              }
              if (stepUsage) {
                cumulativeTokens = getPiAiContextTokensFromStep(stepUsage);
                accumulatedBilling = accumulatePiAiBillingUsage(
                  accumulatedBilling,
                  stepUsage,
                );
                console.log(
                  `[PiCodexToolLoop] Step ${step}: ~${Math.round(cumulativeTokens / 1000)}K context tokens` +
                    ` (${stepUsage.promptTokens} input + ${stepUsage.completionTokens} output` +
                    (stepUsage.cacheReadTokens || stepUsage.cacheWriteTokens
                      ? `, cache read ${stepUsage.cacheReadTokens} / write ${stepUsage.cacheWriteTokens}`
                      : "") +
                    `)`,
                );
                if (
                  stepUsage.cacheReadTokens > 0 ||
                  stepUsage.cacheWriteTokens > 0
                ) {
                  console.log(
                    `[PiCodexToolLoop] 💾 Anthropic cache — read: ${stepUsage.cacheReadTokens}, write: ${stepUsage.cacheWriteTokens} tokens`,
                  );
                }
              }

              if (event.reason === "toolUse") continue;

              // Anthropic can hit maxTokens mid-turn after streaming complete tool_use
              // blocks. Do not yield finish here — orchestrator would terminate and
              // orphan them. shouldDrainOrphanedTools executes pending calls below.
              if (event.reason === "length" && toolCallsThisTurn.length > 0) {
                console.warn(
                  `[PiCodexToolLoop] ⚠️ Model hit maxTokens mid-turn with ${toolCallsThisTurn.length} pending tool call(s). ` +
                    `Skipping finish yield; draining pending tools instead.`,
                );
                continue;
              }

              const finishChunk = adaptPiStreamToAISDKEvent(
                event,
                accumulatedBilling,
              );
              if (
                finishChunk &&
                finishChunk.type === "finish" &&
                finishChunk.usage
              ) {
                (finishChunk.usage as Record<string, unknown>).contextTokens =
                  cumulativeTokens;
              }
              if (finishChunk) yield finishChunk;
              continue;
            }

            const chunk = adaptPiStreamToAISDKEvent(event);
            if (chunk?.type === "error") {
              if (isRetryableProviderCapacityError(chunk.error)) {
                if (rateLimitAttempt < MAX_PROVIDER_RATE_LIMIT_RETRIES) {
                  capacityError = chunk.error;
                  shouldRetryCapacity = true;
                  break;
                }
                yield yieldRateLimitExhausted();
                emitTurnEnd("rate_limit_exhausted");
                return;
              }
            }
            // Defer tool-call UI until we execute — emitting early orphans the
            // turn when capacity retries or wrap-up ends before execution.
            if (chunk?.type === "tool-call") {
              continue;
            }
            if (chunk?.type === "text-delta") {
              const delta = (chunk as { text?: string }).text;
              if (typeof delta === "string") {
                streamedTextChars += delta.length;
                stepText += delta;
              }
            }
            if (chunk) yield chunk;
          }
        }
      } catch (err) {
        if (isRetryableProviderCapacityError(err)) {
          if (rateLimitAttempt < MAX_PROVIDER_RATE_LIMIT_RETRIES) {
            capacityError = err;
            shouldRetryCapacity = true;
          } else {
            yield yieldRateLimitExhausted();
            emitTurnEnd("rate_limit_exhausted");
            return;
          }
        } else {
          throw err;
        }
      }

      if (shouldRetryCapacity && capacityError) {
        const waitMs = computeRateLimitBackoffMs(
          rateLimitAttempt,
          capacityError,
        );
        console.warn(
          `[PiCodexToolLoop] Provider capacity limit (attempt ${rateLimitAttempt + 1}/${MAX_PROVIDER_RATE_LIMIT_RETRIES + 1}). Waiting ${waitMs}ms silently…`,
        );
        await sleepMs(waitMs);
        rateLimitAttempt += 1;
        continue;
      }

      stepStreamCompleted = true;
    }

    const isToolUseStep =
      lastFinishReason === "tool-calls" &&
      toolCallsThisTurn.length > 0 &&
      finalMessage != null;
    // pi-ai can emit toolcall_end (UI shows the call) then done with reason stop/length
    // instead of toolUse — previously we skipped execution and streamOrchestrator
    // marked them orphaned. Drain pending calls before ending the turn.
    const shouldDrainOrphanedTools =
      toolCallsThisTurn.length > 0 &&
      finalMessage != null &&
      (lastFinishReason === "stop" || lastFinishReason === "length");

    if (
      (isToolUseStep || shouldDrainOrphanedTools) &&
      finalMessage != null
    ) {
      if (textOnlyWrapUpStepUsed) {
        // Forced text-only step — pending calls were never emitted to the UI.
        console.warn(
          `[PiCodexToolLoop] Text-only wrap-up: ignoring ${toolCallsThisTurn.length} tool call(s)`,
        );
        emitTurnEnd("text_only_wrap_up_ignored_tools");
        break stepLoop;
      }

      const doneMessage = finalMessage;
      if (shouldDrainOrphanedTools) {
        console.warn(
          `[PiCodexToolLoop] ⚠️ Draining ${toolCallsThisTurn.length} pending tool call(s) ` +
            `after finish reason "${lastFinishReason}" (expected toolUse). ` +
            `Executing to prevent orphaned tool results.`,
        );
      }

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

      // Hard stop only on identical tool+args loops (not same tool with different args).
      // Agent jobs legitimately call bash many times with different commands.
      if (maxRepetitions >= REPETITION_ABORT_THRESHOLD) {
        const repetitiveCall = Array.from(toolCallCounts.entries()).find(
          ([, count]) => count === maxRepetitions,
        );
        const toolName = repetitiveCall?.[0].split(":")[0] ?? "tool";
        console.error(
          `[PiCodexToolLoop] 🛑 HARD STOP: Identical ${toolName} call repeated ${maxRepetitions} times in last ${MAX_RECENT_TOOL_CALLS} calls. Breaking tool loop.`,
        );
        context.messages.push({
          role: "user",
          content:
            `[SYSTEM: You repeated the same ${toolName} call ${maxRepetitions} times without success. ` +
            `STOP retrying this exact call. Explain the validation error to the user and ask how to proceed, ` +
            `or use a different approach (edit_file on an existing app, smaller files payload, fix schema fields).]`,
        } as never);
        emitTurnEnd("repetition_abort");
        break stepLoop;
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
          `Forcing text-only wrap-up.`,
        );
        textOnlyWrapUpStepUsed = true;
        applyForcedTextOnlyWrapUpStep(context, WRAP_UP_AFTER_TOOLS_NO_TEXT);
        logWrapUpTrigger({
          chatId: toolContext?.chatId,
          sessionId: streamOptions.sessionId,
          trigger: "tool_call_hard_limit",
          step,
          totalToolCalls,
        });
        continue stepLoop;
      }
      
      // Execute all tools in parallel — full results preserved for this turn.
      // Stale results from prior turns are compacted before the next model call.
      for (const tc of toolCallsThisTurn) {
        yield {
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        };
      }

      const toolResults = await Promise.all(
        toolCallsThisTurn.map((tc) =>
          executeToolCall(
            tc,
            mastraTools,
            apiKeys,
            toolContext ?? { chatId: streamOptions.sessionId },
          ),
        ),
      );

      for (const tr of toolResults) {
        if (
          tr.result &&
          typeof tr.result === "object" &&
          typeof (tr.result as Record<string, unknown>).error === "string" &&
          String((tr.result as Record<string, unknown>).error).includes(
            "Tool input validation failed",
          )
        ) {
          validationErrorCount++;
        }
        yield {
          type: "tool-result",
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          result: tr.result,
        };
      }

      if (validationErrorCount >= MAX_VALIDATION_ERRORS) {
        console.error(
          `[PiCodexToolLoop] 🚨 CRITICAL: ${validationErrorCount} validation errors detected. Aborting.`,
        );
        yield {
          type: "error",
          error: {
            type: "validation_loop",
            message: `Too many validation errors (${validationErrorCount}). This usually indicates a schema mismatch or malformed tool arguments. Please refresh and try again.`,
          },
        };
        emitTurnEnd("validation_loop");
        break stepLoop;
      }

      // Check if approaching step limit
      const STEP_WARNING_THRESHOLD = 90;
      const STEP_FORCE_STOP_THRESHOLD = 95;
      
      if (step >= STEP_FORCE_STOP_THRESHOLD) {
        console.warn(
          `[PiCodexToolLoop] 🛑 Reached ${step} steps (force stop threshold). Text-only wrap-up.`,
        );
        textOnlyWrapUpStepUsed = true;
        applyForcedTextOnlyWrapUpStep(context, WRAP_UP_AFTER_TOOLS_NO_TEXT);
        logWrapUpTrigger({
          chatId: toolContext?.chatId,
          sessionId: streamOptions.sessionId,
          trigger: "step_limit",
          step,
          totalToolCalls,
        });
        continue stepLoop;
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

      if (isToolUseStep) {
        // Append full tool results for the current turn (never truncated mid-turn).
        appendToolTurnToContext(context, doneMessage, toolResults, cumulativeTokens);

        // Reasoning blocks are only needed while the model is thinking — drop immediately.
        stripAllAssistantReasoning(context.messages as unknown[]);

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
        // Orphan drain — tools ran after stop/length; continue so the model sees results.
        appendToolTurnToContext(context, doneMessage, toolResults, cumulativeTokens);
        stripAllAssistantReasoning(context.messages as unknown[]);
        step++;
        console.log(
          `[PiCodexToolLoop] Step ${step}: orphan drain executed ${toolCallsThisTurn.length} tool(s), continuing`,
        );
        continue stepLoop;
      }
    } else {
      // Model stopped without pending tools. If an active plan still has
      // pending steps this is usually a stop mid-work, not a finished turn —
      // resume the loop (tools intact) instead of ending. Bounded by
      // MAX_PLAN_CONTINUATIONS_PER_TURN in the resolver.
      if (
        resolveModelStop &&
        lastFinishReason !== "length" &&
        !textOnlyWrapUpStepUsed &&
        !streamOptions.signal?.aborted &&
        finalMessage != null
      ) {
        let continuation: { nudge: string; pendingSteps: number } | null = null;
        try {
          continuation = await resolveModelStop({
            trailingText: stepText,
            step,
            totalToolCalls,
            continuationsUsed: planContinuationsUsed,
          });
        } catch (err) {
          // Never let the policy check break a turn that already succeeded.
          console.warn(
            `[PiCodexToolLoop] Plan continuation check failed:`,
            err instanceof Error ? err.message : err,
          );
        }

        if (continuation) {
          planContinuationsUsed += 1;
          console.warn(
            `[TurnEnd:plan-continuation] ${JSON.stringify({
              ts: new Date().toISOString(),
              chatId: toolContext?.chatId ?? null,
              sessionId: streamOptions.sessionId,
              step,
              totalToolCalls,
              pendingSteps: continuation.pendingSteps,
              continuation: planContinuationsUsed,
              trailingTextChars: stepText.trim().length,
            })}`,
          );
          // The assistant's own closing text must land in context before the
          // nudge, or the resumed step cannot see what it just said.
          appendToolTurnToContext(context, finalMessage, [], cumulativeTokens);
          applyPlanContinuationStep(context, continuation.nudge);
          stripAllAssistantReasoning(context.messages as unknown[]);
          step++;
          continue stepLoop;
        }
      }

      // Turn is done; post-stream wrap-up in AgentService adds user text if the
      // sequence ends on tool(s).
      emitTurnEnd(
        lastFinishReason === "length" ? "model_length" : "model_stop",
      );
      break stepLoop;
    }
  }

  if (!turnEndLogged) {
    emitTurnEnd("max_steps_exhausted");
  }
}

/**
 * Adapt a single pi-ai event to OurChunk (same logic as PiToAISDKAdapter but for one event)
 */
function adaptPiStreamToAISDKEvent(
  event: AssistantMessageEvent,
  accumulatedBilling?: PiAiBillingUsage,
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
      
      const billing =
        accumulatedBilling &&
        (accumulatedBilling.promptTokens > 0 ||
          accumulatedBilling.completionTokens > 0 ||
          accumulatedBilling.cacheReadTokens > 0 ||
          accumulatedBilling.cacheWriteTokens > 0)
          ? accumulatedBilling
          : extractPiAiUsageFromDoneEvent(event);

      if (!billing) {
        return { type: "finish", finishReason };
      }

      return {
        type: "finish",
        finishReason,
        usage: {
          promptTokens: billing.promptTokens,
          completionTokens: billing.completionTokens,
          totalTokens: billing.totalTokens,
          cacheReadTokens: billing.cacheReadTokens,
          cacheWriteTokens: billing.cacheWriteTokens,
        },
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
