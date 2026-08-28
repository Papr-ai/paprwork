import { streamText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { StreamChunk } from "../../../core/types/index.js";
import {
  orchestrateModelStream,
  sequenceEndsWithToolWithoutTrailingText,
  type StreamOrchestratorResult,
} from "./streamOrchestrator.js";

export const WRAP_UP_AFTER_ORPHAN_DRAIN =
  "[SYSTEM: You emitted tool calls then stopped before they could run. They have now been executed. " +
  "Provide your final user-facing response — summarize what you accomplished and answer the user. " +
  "Do not call more tools unless strictly necessary.]";

export const WRAP_UP_AFTER_TOOLS_NO_TEXT =
  "[SYSTEM: This turn is complete. Your last action was a tool call with no closing message. " +
  "Write a brief user-facing summary of what you accomplished. Do not plan further edits, " +
  "do not say you will update files next, and do not call tools.]";

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
  if (sequenceHasInterruptedTools(args.sequence)) {
    return false;
  }
  return (
    !args.aborted &&
    !args.isWrapUpContinuation &&
    args.toolCallCount > 0 &&
    sequenceEndsWithToolWithoutTrailingText(args.sequence)
  );
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
    { role: "user", content: WRAP_UP_AFTER_TOOLS_NO_TEXT },
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
    content: WRAP_UP_AFTER_TOOLS_NO_TEXT,
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
