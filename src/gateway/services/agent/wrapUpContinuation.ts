import { streamText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { StreamChunk } from "../../../core/types/index.js";
import {
  orchestrateModelStream,
  type StreamOrchestratorResult,
} from "./streamOrchestrator.js";
import { explainPostStreamWrapUp } from "./turnEndDiagnostics.js";

export const WRAP_UP_AFTER_ORPHAN_DRAIN =
  "[SYSTEM: You emitted tool calls then stopped before they could run. They have now been executed. " +
  "Provide your final user-facing response — summarize what you accomplished and answer the user. " +
  "Do not call more tools unless strictly necessary.]";

export const WRAP_UP_AFTER_TOOLS_NO_TEXT =
  "[SYSTEM: This turn is complete. Your last action was a tool call with no closing message. " +
  "Write a brief user-facing summary of what you accomplished. Do not plan further edits, " +
  "do not say you will update files next, and do not call tools.]";

/**
 * Used instead of WRAP_UP_AFTER_TOOLS_NO_TEXT when the plan still has pending
 * steps. The terminal wording above would tell the user the work was finished
 * when it was not, so this asks for an honest status instead.
 */
export const WRAP_UP_WITH_PLAN_INCOMPLETE =
  "[SYSTEM: Your last action was a tool call with no closing message, and your plan still has " +
  "unfinished steps. Write a brief user-facing status: what you completed, what is still " +
  "outstanding, and what you need in order to finish. Do not claim the task is complete, " +
  "and do not call tools.]";

/** Queue one continuation step with tools left intact so the loop keeps working. */
export function applyPlanContinuationStep(
  context: { messages: unknown[] },
  nudge: string,
): void {
  context.messages.push({
    role: "user",
    content: nudge,
  });
}

/** Disable tools and queue one text-only model step (memory pressure or hard limits). */
export function applyForcedTextOnlyWrapUpStep(
  context: { messages: unknown[]; tools?: unknown[] },
  systemMessage: string,
): void {
  context.tools = [];
  context.messages.push({
    role: "user",
    content: systemMessage,
  });
}

/**
 * After the assistant stream has fully finished (turn done): add one text-only
 * summary when the visible sequence ends on tool call(s) with no trailing text.
 *
 * Forced text-only wrap-up (memory / tool limits) is handled inside the pi tool
 * loop — not here.
 */
export function shouldRequestWrapUpSummary(args: {
  sequence: Array<{ type: string; data: unknown }>;
  toolCallCount: number;
  aborted: boolean;
  isWrapUpContinuation: boolean;
}): boolean {
  return explainPostStreamWrapUp(args).requested;
}

/**
 * Merge a continuation's full result — text, thinking, tools and sequence — so
 * the resumed work persists as one assistant turn and renders in one card.
 *
 * Token usage from the continuation is not merged, matching the existing
 * wrap-up path.
 */
export function mergeContinuationIntoState(
  base: StreamOrchestratorResult,
  continuation: StreamOrchestratorResult,
): StreamOrchestratorResult {
  const trimmed = continuation.assistantText.trim();
  const separator = base.assistantText.trim() && trimmed ? "\n\n" : "";

  return {
    assistantText: base.assistantText + separator + trimmed,
    thinkingText: base.thinkingText + continuation.thinkingText,
    toolCalls: [...base.toolCalls, ...continuation.toolCalls],
    toolResults: [...base.toolResults, ...continuation.toolResults],
    sequence: [...base.sequence, ...continuation.sequence],
  };
}

export function mergeWrapUpTextIntoState(
  base: StreamOrchestratorResult,
  wrapUpText: string,
): StreamOrchestratorResult {
  const trimmed = wrapUpText.trim();
  if (!trimmed) {
    return base;
  }

  const separator = base.assistantText.trim() ? "\n\n" : "";
  return {
    ...base,
    assistantText: base.assistantText + separator + trimmed,
    sequence: [...base.sequence, { type: "text", data: trimmed }],
  };
}

type AiSdkWrapUpArgs = {
  aiSdkResult: {
    response: PromiseLike<{ messages: ModelMessage[] }>;
  };
  streamTextOptions: {
    model: LanguageModel;
    [key: string]: unknown;
  };
  chatId: string;
  apiKeys: string[];
  provider: string;
  abortSignal: AbortSignal;
  /** Defaults to the terminal wording; pass WRAP_UP_WITH_PLAN_INCOMPLETE when steps remain. */
  wrapUpMessage?: string;
};

/** Text-only continuation after AI SDK stream ends on tools without a user reply. */
export async function* runAiSdkWrapUpContinuation(
  args: AiSdkWrapUpArgs,
): AsyncGenerator<
  StreamChunk & { chatId: string },
  StreamOrchestratorResult | null,
  undefined
> {
  const response = await args.aiSdkResult.response;
  const wrapUpMessages: ModelMessage[] = [
    ...response.messages,
    {
      role: "user",
      content: args.wrapUpMessage ?? WRAP_UP_AFTER_TOOLS_NO_TEXT,
    },
  ];

  const wrapUpResult = streamText({
    ...args.streamTextOptions,
    messages: wrapUpMessages,
    tools: {},
    abortSignal: args.abortSignal,
  });

  let fullStream: AsyncIterable<unknown> = wrapUpResult.fullStream;
  if (args.provider === "groq") {
    const { adaptGroqAISDKFullStream } = await import(
      "../../utils/groqProvider.js"
    );
    fullStream = adaptGroqAISDKFullStream(wrapUpResult.fullStream);
  } else if (args.provider === "moonshot") {
    const { adaptMoonshotAISDKFullStream } = await import(
      "../../utils/moonshotProvider.js"
    );
    fullStream = adaptMoonshotAISDKFullStream(wrapUpResult.fullStream);
  }

  const iterator = orchestrateModelStream(fullStream, args.chatId, args.apiKeys, {
    textBufferMin: args.provider === "groq" || args.provider === "moonshot" ? 1 : undefined,
  });

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      const wrapUpText = next.value.assistantText.trim();
      if (!wrapUpText) {
        return null;
      }
      return next.value;
    }
    yield next.value;
  }
}

type AiSdkPlanContinuationArgs = {
  /** Conversation so far, from the finished stream's response. */
  messages: ModelMessage[];
  nudge: string;
  /** Spread as-is so tools, stopWhen and prepareStep stay in force. */
  streamTextOptions: {
    model: LanguageModel;
    [key: string]: unknown;
  };
  chatId: string;
  apiKeys: string[];
  provider: string;
  abortSignal: AbortSignal;
};

/**
 * Resume an AI SDK turn that stopped with plan work outstanding.
 *
 * Unlike the wrap-up runners this keeps tools enabled, so the model can
 * actually do the remaining work rather than narrate it. The AI SDK runs its
 * own tool loop, so one call can span many steps.
 */
export async function* runAiSdkPlanContinuation(
  args: AiSdkPlanContinuationArgs,
): AsyncGenerator<
  StreamChunk & { chatId: string },
  { state: StreamOrchestratorResult; messages: ModelMessage[] } | null,
  undefined
> {
  const result = streamText({
    ...args.streamTextOptions,
    messages: [...args.messages, { role: "user", content: args.nudge }],
    abortSignal: args.abortSignal,
  });

  let fullStream: AsyncIterable<unknown> = result.fullStream;
  if (args.provider === "groq") {
    const { adaptGroqAISDKFullStream } = await import(
      "../../utils/groqProvider.js"
    );
    fullStream = adaptGroqAISDKFullStream(result.fullStream);
  } else if (args.provider === "moonshot") {
    const { adaptMoonshotAISDKFullStream } = await import(
      "../../utils/moonshotProvider.js"
    );
    fullStream = adaptMoonshotAISDKFullStream(result.fullStream);
  }

  const iterator = orchestrateModelStream(fullStream, args.chatId, args.apiKeys, {
    textBufferMin:
      args.provider === "groq" || args.provider === "moonshot" ? 1 : undefined,
  });

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      const state = next.value;
      const producedWork =
        state.assistantText.trim().length > 0 || state.toolCalls.length > 0;
      if (!producedWork) {
        return null;
      }
      const response = await result.response;
      return { state, messages: response.messages };
    }
    yield next.value;
  }
}

type PiAiWrapUpArgs = {
  piContext: { messages: unknown[] };
  streamSimple: (
    model: unknown,
    context: unknown,
    options: unknown,
  ) => AsyncIterable<unknown>;
  piModel: unknown;
  streamOpts: unknown;
  chatId: string;
  apiKeys: string[];
  abortSignal: AbortSignal;
  /** Defaults to the terminal wording; pass WRAP_UP_WITH_PLAN_INCOMPLETE when steps remain. */
  wrapUpMessage?: string;
};

/** Text-only continuation for pi-ai when the tool loop did not produce a summary. */
export async function* runPiAiWrapUpContinuation(
  args: PiAiWrapUpArgs,
): AsyncGenerator<
  StreamChunk & { chatId: string },
  StreamOrchestratorResult | null,
  undefined
> {
  args.piContext.messages.push({
    role: "user",
    content: args.wrapUpMessage ?? WRAP_UP_AFTER_TOOLS_NO_TEXT,
  });

  const contextWithoutTools = {
    ...args.piContext,
    tools: [],
  };

  const { adaptPiStreamToAISDK } = await import(
    "../providers/PiToAISDKAdapter.js"
  );

  const streamOptsRecord =
    typeof args.streamOpts === "object" && args.streamOpts !== null
      ? (args.streamOpts as Record<string, unknown>)
      : {};

  const piStream = args.streamSimple(args.piModel, contextWithoutTools, {
    ...streamOptsRecord,
    signal: args.abortSignal,
  });

  const fullStream = adaptPiStreamToAISDK(
    piStream as AsyncIterable<import("@mariozechner/pi-ai").AssistantMessageEvent>,
  );
  const iterator = orchestrateModelStream(fullStream, args.chatId, args.apiKeys);

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      const wrapUpText = next.value.assistantText.trim();
      if (!wrapUpText) {
        return null;
      }
      return next.value;
    }
    yield next.value;
  }
}
