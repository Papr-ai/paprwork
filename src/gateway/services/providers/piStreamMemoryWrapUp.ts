import {
  compactMidTurnContextForMemoryPressure,
  compactStaleAssistantReasoning,
  compactStaleToolResults,
} from "../agent/compactToolResults.js";
import {
  MID_TURN_MAX_TOKENS,
  trimOldestHistoryTurns,
  type HistoryTrimBounds,
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

export function applyEmergencyMemoryCompaction(
  messages: unknown[],
  historyTrimBounds: HistoryTrimBounds | undefined,
): void {
  compactMidTurnContextForMemoryPressure(messages);
  if (historyTrimBounds) {
    trimOldestHistoryTurns(
      messages as Array<{ role?: unknown; content?: unknown }>,
      {
        ...historyTrimBounds,
        maxTokens: MID_TURN_MAX_TOKENS,
      },
    );
  }
}

export function applyMidTurnContextShaping(
  messages: unknown[],
  historyTrimBounds: HistoryTrimBounds | undefined,
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
      compactStaleToolResults(messages);
    }
  }

  if (historyTrimBounds) {
    trimOldestHistoryTurns(
      messages as Array<{ role?: unknown; content?: unknown }>,
      {
        ...historyTrimBounds,
        maxTokens: MID_TURN_MAX_TOKENS,
      },
    );
  }
}
