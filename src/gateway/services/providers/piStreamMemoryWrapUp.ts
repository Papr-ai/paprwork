import {
  compactMidTurnContextForMemoryPressure,
  compactStaleAssistantReasoning,
  compactStaleToolResults,
} from "../agent/compactToolResults.js";
import {
  MID_TURN_MAX_TOKENS,
  trimOldestHistoryTurns,
  type MidTurnTrimOpts,
} from "../agent/midTurnContextTrim.js";
import type { PiStreamMemoryCheck } from "./piStreamMemoryLimits.js";

export const WRAP_UP_AFTER_MEMORY_BUDGET =
  "[SYSTEM: This turn used a large amount of memory (heavy tool use or long reasoning). " +
  "You MUST stop making tool calls and provide your final response now. " +
  "Summarize what you accomplished, what remains, and any next steps for the user.]";

export type PiStreamMemoryLoopAction =
  | { kind: "continue"; memoryPressure: boolean }
  | { kind: "force_wrap_up" }
  | { kind: "graceful_end" }
  | { kind: "process_error" };

/**
 * Decide how the pi-ai tool loop should react to heap pressure.
 * Stream budget → compact + one wrap-up step; process backstop → hard error.
 */
export function resolvePiStreamMemoryLoopAction(
  check: PiStreamMemoryCheck,
  wrapUpAlreadyUsed: boolean,
): PiStreamMemoryLoopAction {
  if (check.overProcessBackstop) {
    return { kind: "process_error" };
  }

  if (check.overStreamBudget) {
    if (wrapUpAlreadyUsed) {
      return { kind: "graceful_end" };
    }
    return { kind: "force_wrap_up" };
  }

  return { kind: "continue", memoryPressure: check.overStreamWarning };
}

/**
 * Token ceiling for in-flight history on this turn.
 *
 * `MID_TURN_MAX_TOKENS` is only a fallback for callers that cannot compute a
 * model-aware budget. Preferring it over a supplied budget is what let a user
 * who capped a chat at 200K keep filling to 300K — and on a 200K-window model
 * put the ceiling above the window, so trimming could never fire at all.
 */
function resolveTrimCeiling(bounds: MidTurnTrimOpts): number {
  return bounds.maxTokens ?? MID_TURN_MAX_TOKENS;
}

export function applyEmergencyMemoryCompaction(
  messages: unknown[],
  historyTrimBounds: MidTurnTrimOpts | undefined,
): void {
  compactMidTurnContextForMemoryPressure(messages);
  if (historyTrimBounds) {
    trimOldestHistoryTurns(
      messages as Array<{ role?: unknown; content?: unknown }>,
      {
        ...historyTrimBounds,
        maxTokens: resolveTrimCeiling(historyTrimBounds),
      },
    );
  }
}

export function applyMidTurnContextShaping(
  messages: unknown[],
  historyTrimBounds: MidTurnTrimOpts | undefined,
  memoryPressure: boolean,
  opts?: { skipStaleToolCompaction?: boolean },
): void {
  if (memoryPressure) {
    const stats = compactMidTurnContextForMemoryPressure(messages);
    console.warn(
      `[PiCodexToolLoop] Memory-pressure compaction: ` +
        `truncated ${stats.staleResultsTruncated} stale tool result(s), ` +
        `saved ~${Math.round((stats.bytesBefore - stats.bytesAfter) / 1024)}KB`,
    );
  } else {
    compactStaleAssistantReasoning(messages);
    if (!opts?.skipStaleToolCompaction) {
      compactStaleToolResults(messages, {
        historyTokenBudget: historyTrimBounds?.maxTokens,
      });
    }
  }

  if (historyTrimBounds) {
    trimOldestHistoryTurns(
      messages as Array<{ role?: unknown; content?: unknown }>,
      {
        ...historyTrimBounds,
        maxTokens: resolveTrimCeiling(historyTrimBounds),
      },
    );
  }
}
