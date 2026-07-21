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

/** Minimum complete user turns to keep from stored history (before current turn). */
export const MIN_PRESERVED_HISTORY_TURNS = 4;

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
}

export interface MidTurnTrimStats {
  trimmed: boolean;
  removedTurns: number;
  tokensBefore: number;
  tokensAfter: number;
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
  const minPreservedTurns = opts.minPreservedTurns ?? MIN_PRESERVED_HISTORY_TURNS;
  const tokensBefore = estimateMessagesTokens(messages);

  if (tokensBefore <= maxTokens) {
    return {
      trimmed: false,
      removedTurns: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const turnRanges = findHistoryTurnRanges(
    messages,
    opts.historyStartIndex,
    opts.currentTurnStartIndex,
  );

  let removedTurns = 0;
  let currentTurnStartIndex = opts.currentTurnStartIndex;

  while (
    estimateMessagesTokens(messages) > maxTokens &&
    turnRanges.length > minPreservedTurns
  ) {
    const oldest = turnRanges.shift();
    if (!oldest) break;

    const removeCount = oldest.end - oldest.start;
    messages.splice(oldest.start, removeCount);
    removedTurns += 1;
    currentTurnStartIndex -= removeCount;

    for (const turn of turnRanges) {
      turn.start -= removeCount;
      turn.end -= removeCount;
    }
  }

  const tokensAfter = estimateMessagesTokens(messages);

  if (removedTurns > 0) {
    console.log(
      `[midTurnContextTrim] Removed ${removedTurns} oldest history turn(s) — ` +
        `~${Math.round(tokensBefore / 1000)}K → ~${Math.round(tokensAfter / 1000)}K tokens ` +
        `(cap ${Math.round(maxTokens / 1000)}K, kept ${turnRanges.length} history turns)`,
    );
  }

  return {
    trimmed: removedTurns > 0,
    removedTurns,
    tokensBefore,
    tokensAfter,
  };
}
