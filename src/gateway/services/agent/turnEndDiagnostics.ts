import type { PiStreamMemoryCheck } from "../providers/piStreamMemoryLimits.js";
import type { PiStreamMemoryLoopAction } from "../providers/piStreamMemoryWrapUp.js";
import { sequenceEndsWithToolWithoutTrailingText } from "./streamOrchestrator.js";

/** Why a pi-ai tool loop stopped (gateway-side). */
export type PiTurnEndReason =
  | "model_stop"
  | "model_length"
  | "memory_graceful_end"
  | "process_memory_error"
  | "validation_loop"
  | "repetition_abort"
  | "step_limit_wrap_up"
  | "tool_call_hard_limit"
  | "text_only_wrap_up_ignored_tools"
  | "max_steps_exhausted"
  | "rate_limit_exhausted"
  | "provider_error";

export interface PiTurnEndLogInput {
  chatId?: string;
  sessionId?: string;
  reason: PiTurnEndReason;
  step: number;
  maxSteps: number;
  totalToolCalls: number;
  cumulativeTokens?: number;
  modelFinishReason?: string | null;
  textOnlyWrapUpUsed?: boolean;
  validationErrorCount?: number;
  memoryCheck?: PiStreamMemoryCheck;
  memoryAction?: PiStreamMemoryLoopAction["kind"];
  assistantTextPreview?: string;
}

export interface AgentTurnEndLogInput {
  chatId: string;
  route: "pi-ai" | "ai-sdk" | "cursor";
  provider: string;
  model: string;
  toolCallCount: number;
  assistantTextChars: number;
  thinkingTextChars: number;
  sequenceItems: number;
  trailingTextAfterTools: boolean;
  aborted: boolean;
  contextTokens?: number;
  postStreamWrapUpRequested: boolean;
  postStreamWrapUpSkipReason?: string;
  activePlanCount?: number;
  activePlanPendingSteps?: number;
  assistantTextPreview?: string;
  aiSdkStepCount?: number;
  aiSdkForceStop?: boolean;
}

function toMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

export function previewText(text: string, max = 120): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

/** Mid-turn wrap-up trigger (turn continues with text-only step). */
export function logWrapUpTrigger(input: {
  chatId?: string;
  sessionId?: string;
  trigger: "memory_force_wrap_up" | "step_limit" | "tool_call_hard_limit";
  step: number;
  totalToolCalls: number;
  memoryCheck?: PiStreamMemoryCheck;
}): void {
  console.warn(
    `[TurnEnd:wrap-up-trigger] ${JSON.stringify({
      ts: new Date().toISOString(),
      chatId: input.chatId ?? null,
      sessionId: input.sessionId ?? null,
      trigger: input.trigger,
      step: input.step,
      totalToolCalls: input.totalToolCalls,
      memory: input.memoryCheck
        ? {
            streamDeltaMb: toMb(input.memoryCheck.streamDelta),
            heapMb: toMb(input.memoryCheck.heapUsed),
            budgetMb: toMb(input.memoryCheck.streamBudget),
          }
        : null,
    })}`,
  );
}

/** Structured pi-ai loop exit — grep logs for `[TurnEnd]`. */
export function logPiTurnEnd(input: PiTurnEndLogInput): void {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    layer: "pi-ai-loop",
    chatId: input.chatId ?? null,
    sessionId: input.sessionId ?? null,
    reason: input.reason,
    step: input.step,
    maxSteps: input.maxSteps,
    totalToolCalls: input.totalToolCalls,
    cumulativeTokensK: input.cumulativeTokens
      ? Math.round(input.cumulativeTokens / 1000)
      : null,
    modelFinishReason: input.modelFinishReason ?? null,
    textOnlyWrapUpUsed: input.textOnlyWrapUpUsed ?? false,
    validationErrors: input.validationErrorCount ?? 0,
  };

  if (input.memoryCheck) {
    payload.memory = {
      streamDeltaMb: toMb(input.memoryCheck.streamDelta),
      heapMb: toMb(input.memoryCheck.heapUsed),
      budgetMb: toMb(input.memoryCheck.streamBudget),
      overBudget: input.memoryCheck.overStreamBudget,
      overBackstop: input.memoryCheck.overProcessBackstop,
      confirmedAfterGc: input.memoryCheck.confirmedAfterGc,
      action: input.memoryAction ?? null,
    };
  }

  if (input.assistantTextPreview) {
    payload.textPreview = input.assistantTextPreview;
  }

  console.warn(`[TurnEnd] ${JSON.stringify(payload)}`);
}

/** Memory pressure during pi-ai loop (may continue or force wrap-up next). */
export function logPiStreamMemoryCheck(args: {
  chatId?: string;
  step: number;
  check: PiStreamMemoryCheck;
  action: PiStreamMemoryLoopAction;
}): void {
  const { check, action } = args;
  if (
    action.kind === "continue" &&
    !check.overStreamWarning &&
    !check.overStreamBudget
  ) {
    return;
  }

  console.warn(
    `[TurnEnd:memory] ${JSON.stringify({
      ts: new Date().toISOString(),
      chatId: args.chatId ?? null,
      step: args.step,
      action: action.kind,
      memoryPressure:
        action.kind === "continue" ? action.memoryPressure : undefined,
      streamDeltaMb: toMb(check.streamDelta),
      heapMb: toMb(check.heapUsed),
      budgetMb: toMb(check.streamBudget),
      overBudget: check.overStreamBudget,
      overBackstop: check.overProcessBackstop,
      confirmedAfterGc: check.confirmedAfterGc,
    })}`,
  );
}

export function explainPostStreamWrapUp(args: {
  sequence: Array<{ type: string; data: unknown }>;
  toolCallCount: number;
  aborted: boolean;
  isWrapUpContinuation: boolean;
}): { requested: boolean; skipReason?: string } {
  if (args.aborted) {
    return { requested: false, skipReason: "aborted" };
  }
  if (args.isWrapUpContinuation) {
    return { requested: false, skipReason: "wrap_up_continuation" };
  }
  if (args.toolCallCount === 0) {
    return { requested: false, skipReason: "no_tool_calls" };
  }
  if (sequenceHasInterruptedTools(args.sequence)) {
    return { requested: false, skipReason: "interrupted_tools" };
  }
  if (!sequenceEndsWithToolWithoutTrailingText(args.sequence)) {
    return { requested: false, skipReason: "trailing_text_after_tools" };
  }
  return { requested: true };
}

function sequenceHasInterruptedTools(
  sequence: Array<{ type: string; data: unknown }>,
): boolean {
  return sequence.some((item) => {
    if (item.type !== "tool") {
      return false;
    }
    const status = (item.data as { status?: string }).status;
    return status === "interrupted" || status === "calling";
  });
}

/** Final turn summary from AgentService after stream orchestration. */
export function logAgentTurnEnd(input: AgentTurnEndLogInput): void {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    layer: "agent-service",
    chatId: input.chatId,
    route: input.route,
    provider: input.provider,
    model: input.model,
    toolCalls: input.toolCallCount,
    assistantTextChars: input.assistantTextChars,
    thinkingTextChars: input.thinkingTextChars,
    sequenceItems: input.sequenceItems,
    trailingTextAfterTools: input.trailingTextAfterTools,
    aborted: input.aborted,
    contextTokensK: input.contextTokens
      ? Math.round(input.contextTokens / 1000)
      : null,
    postStreamWrapUp: input.postStreamWrapUpRequested
      ? "requested"
      : input.postStreamWrapUpSkipReason ?? "not_needed",
    activePlans: input.activePlanCount ?? 0,
    activePlanPendingSteps: input.activePlanPendingSteps ?? 0,
  };

  if (input.aiSdkStepCount != null) {
    payload.aiSdkSteps = input.aiSdkStepCount;
    payload.aiSdkForceStop = input.aiSdkForceStop ?? false;
  }

  if (input.assistantTextPreview) {
    payload.textPreview = input.assistantTextPreview;
  }

  // Incomplete plan + model stopped with text = the common "why did it stop?" case.
  if (
    (input.activePlanPendingSteps ?? 0) > 0 &&
    input.trailingTextAfterTools &&
    !input.postStreamWrapUpRequested &&
    !input.aborted
  ) {
    payload.likelyCause =
      "model_stop_with_pending_plan_steps (not gateway wrap-up)";
  }

  console.warn(`[TurnEnd] ${JSON.stringify(payload)}`);
}
