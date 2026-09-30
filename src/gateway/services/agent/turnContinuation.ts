/**
 * Turn-end policy: end the turn, close it with a summary, or push the model to
 * keep going.
 *
 * The decision used to be binary — request a terminal wrap-up or do nothing —
 * and both outcomes end the turn. A model that stopped mid-plan was therefore
 * reported to the user as finished, and when it had stopped on a tool call the
 * gateway went further and injected "This turn is complete … do not call tools",
 * manufacturing a completion over unfinished work.
 *
 * Continuation is gated on an active plan with pending steps: with no plan there
 * is no reliable signal that work remains, so those turns keep the old behavior.
 */

/** Continuations allowed per turn before we stop pushing and report honestly. */
export const MAX_PLAN_CONTINUATIONS_PER_TURN = 2;

export type TurnEndAction = "wrap_up" | "continue" | "none";

/**
 * `complete` closes the turn ("you are done, do not call tools").
 * `plan_incomplete` asks for a summary that states what remains — never claims
 * the work is finished.
 */
export type WrapUpKind = "complete" | "plan_incomplete";

export interface TurnEndDecision {
  action: TurnEndAction;
  /** Stable identifier for logs and tests. */
  reason: string;
  wrapUpKind?: WrapUpKind;
}

/**
 * Phrases that mean the model handed control back rather than stopping
 * mid-task. Continuing past one of these would steamroll a question the user
 * has to answer, so it counts as a legitimate stop even with steps pending.
 */
const AWAITS_USER_PATTERNS: RegExp[] = [
  /\blet me know\b/i,
  /\bfor your approval\b/i,
  /\byour call\b/i,
  /\bsay the word\b/i,
  /\bshall i\b/i,
  /\bshould i\b/i,
  /\bwant me to\b/i,
  /\bdo you want\b/i,
  /\bwould you (like|prefer|rather)\b/i,
  /\bwhich (one|would you|do you)\b/i,
  /\btell me (which|whether|if)\b/i,
  /\bawaiting your\b/i,
  /\bwaiting on you\b/i,
  /\bneed your (input|decision|call|sign-?off)\b/i,
  /\bconfirm before\b/i,
];

/**
 * Only the tail is inspected: a question early in a long progress report is not
 * a handoff, but a question at the very end is.
 */
const AWAITS_USER_TAIL_CHARS = 400;

/** True when the trailing text reads as handing control back to the user. */
export function trailingTextAwaitsUser(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const tail = trimmed.slice(-AWAITS_USER_TAIL_CHARS);

  // A trailing question mark is the clearest handoff signal. Ignore a trailing
  // markdown list/emphasis marker so "…which one? **" still counts.
  if (/\?["'`*_)\]\s]*$/.test(tail)) {
    return true;
  }

  return AWAITS_USER_PATTERNS.some((pattern) => pattern.test(tail));
}

/**
 * Text the model emitted after its last tool call. This is what distinguishes a
 * closing summary from a mid-work preamble like "Now let me check the launcher:".
 */
export function trailingTextAfterLastTool(
  sequence: Array<{ type: string; data: unknown }>,
): string {
  let lastToolIndex = -1;
  for (let i = sequence.length - 1; i >= 0; i--) {
    if (sequence[i]?.type === "tool") {
      lastToolIndex = i;
      break;
    }
  }

  const parts: string[] = [];
  for (let i = lastToolIndex + 1; i < sequence.length; i++) {
    const item = sequence[i];
    if (item?.type === "text" && typeof item.data === "string") {
      parts.push(item.data);
    }
  }
  return parts.join("");
}

export interface TurnEndInput {
  /** Unfinished (not completed, not skipped) steps across active plans. */
  pendingPlanSteps: number;
  /** Model text emitted after the last tool call, if any. */
  trailingText: string;
  /** True when the visible sequence ends on tool call(s) with no text after. */
  endsOnToolWithoutText: boolean;
  toolCallCount: number;
  aborted: boolean;
  /** Tool calls left hanging — a different failure, handled elsewhere. */
  hasInterruptedTools: boolean;
  /** Continuations already spent this turn. */
  continuationsUsed: number;
  maxContinuations?: number;
}

export function decideTurnEnd(input: TurnEndInput): TurnEndDecision {
  const maxContinuations =
    input.maxContinuations ?? MAX_PLAN_CONTINUATIONS_PER_TURN;

  if (input.aborted) {
    return { action: "none", reason: "aborted" };
  }
  if (input.toolCallCount === 0) {
    // Nothing ran, so the model answered directly. Pushing it to "continue"
    // here would fight a deliberate text-only reply.
    return { action: "none", reason: "no_tool_calls" };
  }
  if (input.hasInterruptedTools) {
    return { action: "none", reason: "interrupted_tools" };
  }

  if (input.pendingPlanSteps <= 0) {
    // Original behavior: close the turn only when the model went silent.
    return input.endsOnToolWithoutText
      ? {
          action: "wrap_up",
          reason: "tools_without_reply",
          wrapUpKind: "complete",
        }
      : { action: "none", reason: "trailing_text_after_tools" };
  }

  if (trailingTextAwaitsUser(input.trailingText)) {
    return { action: "none", reason: "awaiting_user_input" };
  }

  if (input.continuationsUsed < maxContinuations) {
    return { action: "continue", reason: "plan_steps_pending" };
  }

  // Out of continuations. Never claim completion — if the model also went
  // silent, ask for a summary that says what is still outstanding.
  return input.endsOnToolWithoutText
    ? {
        action: "wrap_up",
        reason: "continuation_budget_exhausted",
        wrapUpKind: "plan_incomplete",
      }
    : { action: "none", reason: "continuation_budget_exhausted" };
}

export function buildPlanContinuationNudge(args: {
  pendingSteps: number;
  nextStepDescription?: string;
}): string {
  const stepLabel = args.pendingSteps === 1 ? "step" : "steps";
  const next = args.nextStepDescription?.trim()
    ? `\nNext pending step: "${args.nextStepDescription.trim()}"`
    : "";

  return (
    `[SYSTEM: Your active plan still has ${args.pendingSteps} unfinished ${stepLabel}, ` +
    `and you stopped without completing them or telling the user you were done.${next}\n` +
    `Continue now: do the work for that step with tools, then call update_plan to record progress. ` +
    `Do not re-summarize what you already did, and do not create a new plan. ` +
    `If you truly cannot proceed without a decision from the user, ask one direct question and stop.]`
  );
}
