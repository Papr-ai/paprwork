/**
 * Mid-turn context trimming — drop oldest stored-history turns from the in-flight
 * prompt when estimated size exceeds MID_TURN_MAX_TOKENS.
 *
 * Only mutates the ephemeral messages array sent to the model (never storage).
 * Preserves the current user turn and all tool steps in progress.
 */

import { ACTIVE_PLANS_MESSAGE_PREFIX } from "../../../core/agents/SystemPrompt.js";
import { AGENT_FOCUS_CONTEXT_PREFIX } from "./focusContextFormatter.js";
import { isMemoryContextUserMessage } from "../UserMemoryContextService.js";
import { estimateMessagesTokens } from "./compactToolResults.js";

/** Soft ceiling for in-flight context during a multi-step turn. */
export const MID_TURN_MAX_TOKENS = 300_000;

/**
 * Complete user turns to keep from stored history when the budget still fits.
 *
 * A target, not a guarantee — see {@link HARD_MIN_PRESERVED_HISTORY_TURNS}.
 */
export const MIN_PRESERVED_HISTORY_TURNS = 4;

/**
 * Turns kept once the soft floor cannot be reconciled with the budget.
 *
 * {@link MIN_PRESERVED_HISTORY_TURNS} was an unconditional stop, which made a
 * user's context cap a target the trimmer was free to miss rather than a
 * ceiling. On a chat capped at 200K, the four most recent turns carried 250
 * tool results across ~1MB, so the loop exited with all four still in the
 * prompt and the context at 350-458K — over cap on every turn, by up to 2.3x.
 *
 * Keeping one turn of context at some overshoot is a reasonable trade; keeping
 * four at 2.3x the cap is not. The current in-progress turn is protected
 * structurally by `currentTurnStartIndex` and is never a candidate here.
 */
export const HARD_MIN_PRESERVED_HISTORY_TURNS = 1;

const CONVERSATION_SUMMARY_PREFIX = "[CONVERSATION CONTEXT";
const SYSTEM_NOTE_PREFIX = "[SYSTEM NOTE:";

export interface HistoryTrimBounds {
  /** First index eligible for turn trimming (after system / injected context). */
  historyStartIndex: number;
  /** Index of the user message starting the current agent turn — never trimmed. */
  currentTurnStartIndex: number;
}

export interface MidTurnTrimOpts extends HistoryTrimBounds {
  maxTokens?: number;
  minPreservedTurns?: number;
  /** Floor once the soft floor cannot meet `maxTokens`. Never above it. */
  hardMinPreservedTurns?: number;
}

export interface MidTurnTrimStats {
  trimmed: boolean;
  removedTurns: number;
  tokensBefore: number;
  tokensAfter: number;
  /** Turns removed only because the soft floor overshot the budget. */
  removedBelowSoftFloor: number;
  /**
   * Whether the prompt ended up within `maxTokens`.
   *
   * False means even the hard floor could not satisfy the cap — a single turn,
   * the system prompt, or the tool schemas exceed it on their own. That is not
   * recoverable by trimming, so it is worth surfacing rather than silently
   * shipping an over-cap prompt.
   */
  budgetMet: boolean;
}

function getUserTextContent(msg: { role?: unknown; content?: unknown }): string {
  if (msg.role !== "user") return "";
  return typeof msg.content === "string" ? msg.content : "";
}

export function isInjectedContextUserMessage(content: string): boolean {
  if (!content) return false;
  return (
    content.startsWith(CONVERSATION_SUMMARY_PREFIX) ||
    content.startsWith(SYSTEM_NOTE_PREFIX) ||
    content.startsWith(ACTIVE_PLANS_MESSAGE_PREFIX) ||
    content.startsWith(AGENT_FOCUS_CONTEXT_PREFIX) ||
    isMemoryContextUserMessage(content)
  );
}

function isHistoryTurnStart(msg: { role?: unknown; content?: unknown }): boolean {
  if (msg.role !== "user") return false;
  return !isInjectedContextUserMessage(getUserTextContent(msg));
}

/**
 * Locate stored-history vs current-turn boundary in the messages array
 * about to be sent to the model (AI SDK or pi-ai format).
 */
export function computeHistoryTrimBounds(
  messages: Array<{ role?: unknown; content?: unknown }>,
): HistoryTrimBounds {
  let historyStartIndex = 0;
  while (
    historyStartIndex < messages.length &&
    messages[historyStartIndex]?.role === "system"
  ) {
    historyStartIndex += 1;
  }

  let currentTurnStartIndex = messages.length;
  for (let i = messages.length - 1; i >= historyStartIndex; i -= 1) {
    if (isHistoryTurnStart(messages[i] ?? {})) {
      currentTurnStartIndex = i;
      break;
    }
  }

  return { historyStartIndex, currentTurnStartIndex };
}

interface TurnRange {
  start: number;
  end: number;
}

function findHistoryTurnRanges(
  messages: Array<{ role?: unknown; content?: unknown }>,
  historyStartIndex: number,
  currentTurnStartIndex: number,
): TurnRange[] {
  const turns: TurnRange[] = [];
  let i = historyStartIndex;

  while (i < currentTurnStartIndex) {
    if (!isHistoryTurnStart(messages[i] ?? {})) {
      i += 1;
      continue;
    }
    const start = i;
    i += 1;
    while (i < currentTurnStartIndex && !isHistoryTurnStart(messages[i] ?? {})) {
      i += 1;
    }
    turns.push({ start, end: i });
  }

  return turns;
}

/**
 * Remove oldest stored-history turns until estimated tokens <= maxTokens.
 * Mutates `messages` in place.
 */
export function trimOldestHistoryTurns(
  messages: Array<{ role?: unknown; content?: unknown }>,
  opts: MidTurnTrimOpts,
): MidTurnTrimStats {
  const maxTokens = opts.maxTokens ?? MID_TURN_MAX_TOKENS;
  const softFloor = opts.minPreservedTurns ?? MIN_PRESERVED_HISTORY_TURNS;
  // A caller asking to keep fewer turns than the hard floor is asking for the
  // smaller number, so the hard floor can only ever lower the soft one.
  const hardFloor = Math.min(
    softFloor,
    opts.hardMinPreservedTurns ?? HARD_MIN_PRESERVED_HISTORY_TURNS,
  );
  const tokensBefore = estimateMessagesTokens(messages);

  if (tokensBefore <= maxTokens) {
    return {
      trimmed: false,
      removedTurns: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      removedBelowSoftFloor: 0,
      budgetMet: true,
    };
  }

  const turnRanges = findHistoryTurnRanges(
    messages,
    opts.historyStartIndex,
    opts.currentTurnStartIndex,
  );

  let currentTurnStartIndex = opts.currentTurnStartIndex;

  const trimDownTo = (floor: number): number => {
    let removed = 0;
    while (
      estimateMessagesTokens(messages) > maxTokens &&
      turnRanges.length > floor
    ) {
      const oldest = turnRanges.shift();
      if (!oldest) break;

      const removeCount = oldest.end - oldest.start;
      messages.splice(oldest.start, removeCount);
      removed += 1;
      currentTurnStartIndex -= removeCount;

      for (const turn of turnRanges) {
        turn.start -= removeCount;
        turn.end -= removeCount;
      }
    }
    return removed;
  };

  let removedTurns = trimDownTo(softFloor);

  // Still over cap with the soft floor intact means the preserved turns alone
  // exceed the budget. Stopping here is what let a 200K cap ship a 458K prompt,
  // so descend to the hard floor rather than leave the cap unmet.
  const removedBelowSoftFloor =
    estimateMessagesTokens(messages) > maxTokens ? trimDownTo(hardFloor) : 0;
  removedTurns += removedBelowSoftFloor;

  const tokensAfter = estimateMessagesTokens(messages);
  const budgetMet = tokensAfter <= maxTokens;

  if (removedTurns > 0) {
    console.log(
      `[midTurnContextTrim] Removed ${removedTurns} oldest history turn(s) — ` +
        `~${Math.round(tokensBefore / 1000)}K → ~${Math.round(tokensAfter / 1000)}K tokens ` +
        `(cap ${Math.round(maxTokens / 1000)}K, kept ${turnRanges.length} history turns)` +
        (removedBelowSoftFloor > 0
          ? ` — ${removedBelowSoftFloor} of those dropped below the ${softFloor}-turn ` +
            `preference to honour the cap`
          : ""),
    );
  }

  if (!budgetMet) {
    console.warn(
      `[midTurnContextTrim] Prompt still over cap after trimming to ` +
        `${turnRanges.length} history turn(s): ~${Math.round(tokensAfter / 1000)}K ` +
        `> ${Math.round(maxTokens / 1000)}K. A single turn, the system prompt, or the ` +
        `tool schemas exceed the budget on their own — trimming history cannot fix this.`,
    );
  }

  return {
    trimmed: removedTurns > 0,
    removedTurns,
    tokensBefore,
    tokensAfter,
    removedBelowSoftFloor,
    budgetMet,
  };
}
