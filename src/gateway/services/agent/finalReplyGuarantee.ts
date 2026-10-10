/**
 * Final-reply guarantee: a chat turn never ends on "Finished Working" with
 * nothing to read.
 *
 * Seen in production (chats.db): assistant rows with thinking and tool calls
 * but `content = ""`, `error = NULL`, `incomplete = 0`. The UI drew "Finished
 * Working" over a list of tool calls and no answer. Three paths led there, on
 * every provider and on both routes (AI SDK and pi-ai):
 *
 *  1. The post-tool wrap-up came back without text. It reuses the turn's own
 *     options, so a model with reasoning on (Anthropic adaptive thinking,
 *     OpenAI reasoning effort, a Gemini thinking budget, Ollama `think`) can
 *     spend the whole step reasoning and close with no text. The runner
 *     returned null and the caller merged nothing.
 *  2. The wrap-up failed (context overflow, 5xx, refusal). The error was
 *     logged and dropped.
 *  3. The turn paused at a tool boundary for a queued follow-up (steer/yield)
 *     that never ran because the queued message was removed or edited.
 *
 * The contract, independent of provider and route:
 *  - an empty or failed wrap-up is retried once text-first: reasoning turned
 *    down through each provider's own control, plus a stricter instruction;
 *  - if the turn still has no visible reply, a short deterministic note says
 *    what happened and how to continue. It needs no model call, so it cannot
 *    fail the way the model did.
 *
 * Aborted turns (the user pressed Stop), transport failures (auto-continue
 * owns those) and turns with interrupted tools keep their own handling.
 */
import type { StreamChunk } from "../../../core/types/index.js";
import { anthropicModelUsesAdaptiveThinking } from "../../utils/anthropicAdaptiveThinking.js";
import {
  sequenceEndsWithToolWithoutTrailingText,
  type StreamOrchestratorResult,
} from "./streamOrchestrator.js";
import { sequenceHasInterruptedTools } from "./turnEndDiagnostics.js";

type SequenceItem = { type: string; data: unknown };
type ChatChunk = StreamChunk & { chatId: string };
type ProviderOptions = Record<string, Record<string, unknown> | undefined>;

export type WrapUpMode = "default" | "text-first";

export type WrapUpOutcome =
  | { kind: "not_attempted" }
  | { kind: "text"; attempts: number }
  | { kind: "empty"; attempts: number }
  | { kind: "error"; attempts: number; message: string };

export interface WrapUpRetryResult {
  state: StreamOrchestratorResult | null;
  outcome: WrapUpOutcome;
}

export type NoReplyReason =
  /** Paused at a tool boundary so the user's follow-up runs next. */
  | "yielded_to_user"
  /** The wrap-up (and its retry) failed with an error. */
  | "wrap_up_error"
  /** The wrap-up (and its retry) produced reasoning or nothing, but no text. */
  | "wrap_up_empty"
  /** No text, no reasoning, no tools — even after the silent retry. */
  | "empty_response"
  /** Anything else that ended without visible text. */
  | "no_text";

/** Thinking budget for a Gemini text-first retry: valid for every 2.5+ tier. */
export const TEXT_FIRST_GOOGLE_THINKING_BUDGET = 1024;

/**
 * Output floor for a text-first retry. Measured live: at low effort Opus 5.5
 * still reasons ~300 tokens before answering, so a 256-token step ends on
 * `length` with no text while 4096 answers every time.
 */
export const TEXT_FIRST_MIN_OUTPUT_TOKENS = 4096;

export const WRAP_UP_TEXT_FIRST_RETRY =
  "[SYSTEM: Your previous attempt to close this turn produced no visible text. " +
  "Reply to the user now, in plain text: 2-6 sentences on what you did, what you found, " +
  "and the next step. Answer directly without extended reasoning, and do not call tools.]";

export const WRAP_UP_TEXT_FIRST_RETRY_PLAN_INCOMPLETE =
  "[SYSTEM: Your previous attempt to close this turn produced no visible text, and your plan " +
  "still has unfinished steps. Reply to the user now, in plain text: what you completed, what is " +
  "still outstanding, and what you need in order to finish. Answer directly without extended " +
  "reasoning, do not claim the task is complete, and do not call tools.]";

/**
 * True when the turn is about to be saved with nothing the user can read
 * after its work: no text at all, or tools ran and no text followed them.
 */
export function needsFinalReplyFallback(input: {
  sequence: SequenceItem[];
  assistantText: string;
  toolCallCount: number;
  aborted: boolean;
  isWrapUpContinuation: boolean;
  providerStreamFailed: boolean;
}): boolean {
  if (input.aborted || input.isWrapUpContinuation || input.providerStreamFailed) {
    return false;
  }
  if (sequenceHasInterruptedTools(input.sequence)) {
    return false;
  }
  if (!input.assistantText.trim()) {
    return true;
  }
  return (
    input.toolCallCount > 0 &&
    sequenceEndsWithToolWithoutTrailingText(input.sequence)
  );
}

export function classifyNoReply(input: {
  yieldedToUser: boolean;
  wrapUp: WrapUpOutcome;
  toolCallCount: number;
  thinkingText: string;
}): NoReplyReason {
  if (input.yieldedToUser) return "yielded_to_user";
  if (input.wrapUp.kind === "error") return "wrap_up_error";
  if (input.wrapUp.kind === "empty") return "wrap_up_empty";
  if (input.toolCallCount === 0 && !input.thinkingText.trim()) {
    return "empty_response";
  }
  return "no_text";
}

/** "bash ×3, get_full_tool_result" — at most four names, then "N more". */
export function summarizeToolNames(toolNames: string[]): string {
  const counts = new Map<string, number>();
  for (const raw of toolNames) {
    const name = raw?.trim() || "tool";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, count]) =>
    count > 1 ? `${name} ×${count}` : name,
  );
  const shown = parts.slice(0, 4);
  if (parts.length > 4) shown.push(`${parts.length - 4} more`);
  return shown.join(", ");
}

/** First line of an error, credentials redacted, bounded for a chat line. */
export function shortErrorForUser(message: string | undefined, max = 160): string {
  const firstLine = (message ?? "").split("\n")[0]?.trim() || "unknown error";
  const redacted = firstLine.replace(
    /(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|[A-Za-z0-9_-]{40,})/g,
    "[redacted]",
  );
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** The note that closes a turn the model left without a reply. Never empty. */
export function buildNoReplyFallback(input: {
  reason: NoReplyReason;
  toolNames: string[];
  errorMessage?: string;
  pendingPlanSteps?: number;
}): string {
  if (input.reason === "yielded_to_user") {
    return "_Paused after this step to read your new message._";
  }
  if (input.reason === "empty_response") {
    return (
      "_The model returned an empty response. Send your message again, " +
      "or switch models if it keeps happening._"
    );
  }
  const toolCount = input.toolNames.length;
  const why =
    input.reason === "wrap_up_error"
      ? `writing the reply failed (${shortErrorForUser(input.errorMessage)})`
      : toolCount > 0
        ? "the model stopped after its tool calls without writing any text"
        : "the model finished reasoning without writing any text";
  const ran =
    toolCount > 0
      ? ` Ran ${toolCount} tool call${toolCount === 1 ? "" : "s"} ` +
        `(${summarizeToolNames(input.toolNames)}).`
      : "";
  const pending =
    input.pendingPlanSteps && input.pendingPlanSteps > 0
      ? ` ${input.pendingPlanSteps} plan step${input.pendingPlanSteps === 1 ? " is" : "s are"} still open.`
      : "";
  return (
    `_This turn ended without a reply: ${why}.${ran}${pending} ` +
    `Say "continue" and I'll summarize and pick up from here._`
  );
}

/**
 * Provider options for a text-first retry: the same request, with reasoning
 * turned down through each provider's own control. Pure — the input is not
 * modified. Providers without a reasoning option pass through unchanged.
 */
export function textFirstProviderOptions(
  model: string,
  providerOptions: ProviderOptions | undefined,
): ProviderOptions | undefined {
  if (!providerOptions) return providerOptions;
  const next: ProviderOptions = { ...providerOptions };

  const anthropic = providerOptions.anthropic;
  if (anthropic) {
    const options: Record<string, unknown> = { ...anthropic };
    if (anthropicModelUsesAdaptiveThinking(model)) {
      // Effort is the dial these models honor. `thinking: disabled` never
      // reaches the API on this route (the AI SDK provider drops it) and
      // Sonnet 5.5 reasons by default, so "off" measured as full-depth hidden
      // reasoning ending on `length`; adaptive at low effort answered.
      options.thinking = { type: "adaptive", display: "summarized" };
      options.effort = "low";
    } else if (options.thinking) {
      // Budget-thinking models only reason when asked to.
      delete options.thinking;
    }
    next.anthropic = options;
  }

  const openai = providerOptions.openai;
  if (openai && "reasoningEffort" in openai) {
    next.openai = { ...openai, reasoningEffort: "low" };
  }

  const google = providerOptions.google;
  const thinkingConfig = google?.thinkingConfig as
    | { includeThoughts?: boolean; thinkingBudget?: number }
    | undefined;
  if (google && thinkingConfig && (thinkingConfig.thinkingBudget ?? 0) > 0) {
    next.google = {
      ...google,
      thinkingConfig: {
        includeThoughts: false,
        thinkingBudget: Math.min(
          thinkingConfig.thinkingBudget ?? TEXT_FIRST_GOOGLE_THINKING_BUDGET,
          TEXT_FIRST_GOOGLE_THINKING_BUDGET,
        ),
      },
    };
  }

  const ollama = providerOptions.ollama;
  if (ollama && ollama.think === true) {
    next.ollama = { ...ollama, think: false };
  }

  return next;
}

/**
 * `streamText` options for a text-first retry (AI SDK route): reasoning turned
 * down, and room for a short answer even when the turn's budget was tight.
 */
export function withTextFirstStreamTextOptions<
  T extends { [key: string]: unknown },
>(options: T, model: string): T {
  const providerOptions = options.providerOptions as ProviderOptions | undefined;
  const maxOutputTokens = options.maxOutputTokens;
  const raiseBudget =
    typeof maxOutputTokens === "number" &&
    maxOutputTokens < TEXT_FIRST_MIN_OUTPUT_TOKENS;
  if (!providerOptions && !raiseBudget) return options;
  return {
    ...options,
    ...(providerOptions
      ? { providerOptions: textFirstProviderOptions(model, providerOptions) }
      : {}),
    ...(raiseBudget ? { maxOutputTokens: TEXT_FIRST_MIN_OUTPUT_TOKENS } : {}),
  };
}

function errorTextFromChunk(chunk: ChatChunk): string {
  const payload = (chunk as { payload?: { error?: unknown } }).payload;
  return errorMessageOf(payload?.error ?? "model error");
}

/**
 * Run the wrap-up, and once more text-first if it produced no text.
 *
 * Chunks stream through as they arrive, except `error` chunks: a failed
 * attempt is retried or replaced by the note, so its error becomes the
 * outcome's reason rather than a banner over a turn that may still reply.
 */
export async function* runWrapUpWithRetry(args: {
  chatId: string;
  abortSignal: AbortSignal;
  attempt: (
    mode: WrapUpMode,
  ) => AsyncGenerator<ChatChunk, StreamOrchestratorResult | null, undefined> | null;
  onAttemptStart?: (mode: WrapUpMode, attemptNumber: number) => void;
}): AsyncGenerator<ChatChunk, WrapUpRetryResult, undefined> {
  const modes: WrapUpMode[] = ["default", "text-first"];
  let outcome: WrapUpOutcome = { kind: "not_attempted" };

  for (let index = 0; index < modes.length; index++) {
    const mode = modes[index] as WrapUpMode;
    const attemptNumber = index + 1;
    if (args.abortSignal.aborted) break;

    let streamError: string | undefined;
    try {
      const iterator = args.attempt(mode);
      if (!iterator) break;
      args.onAttemptStart?.(mode, attemptNumber);
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          const state = next.value;
          if (state && state.assistantText.trim()) {
            return { state, outcome: { kind: "text", attempts: attemptNumber } };
          }
          break;
        }
        if (next.value.type === "error") {
          streamError = errorTextFromChunk(next.value);
          continue;
        }
        yield next.value;
      }
      outcome = streamError
        ? { kind: "error", attempts: attemptNumber, message: streamError }
        : { kind: "empty", attempts: attemptNumber };
    } catch (error) {
      outcome = {
        kind: "error",
        attempts: attemptNumber,
        message: errorMessageOf(error),
      };
    }

    console.warn(
      `[TurnEnd:wrap-up-no-text] ${JSON.stringify({
        ts: new Date().toISOString(),
        chatId: args.chatId,
        mode,
        attempt: attemptNumber,
        outcome: outcome.kind,
        ...(outcome.kind === "error"
          ? { error: shortErrorForUser(outcome.message) }
          : {}),
      })}`,
    );
  }

  return { state: null, outcome };
}
