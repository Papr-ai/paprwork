/**
 * Per-step nudge toward batching independent tool calls.
 *
 * Steps are the billed unit: every step re-sends the whole prefix, so on a
 * 34-step turn with a ~270K prefix a single step costs roughly $0.20 in cache
 * reads and the turn's output is a rounding error beside it. Measured across
 * this workspace, 84% of Anthropic spend is carriage between steps and 6% is
 * output. Halving the step count therefore halves the turn.
 *
 * The system prompt already asks for batching with a width target and worked
 * examples (Enhancement 95). That moved the measured width from 1.16 to 1.24
 * tool calls per step against a target of 2.5 — real but small, which is the
 * expected shape: a standing instruction competes with everything else in a
 * 46K prompt and is furthest away exactly when the model is deepest in a turn.
 *
 * This adds the missing half — feedback at the point of decision. The nudge is
 * appended after a step that used exactly one tool call, states the measured
 * width, and names a target that *descends* with step number: early steps are
 * exploratory and genuinely parallel, later steps are usually converging on a
 * single edit and asking for width there produces padding.
 *
 * Deliberately a floor and never a ceiling. A fixed tool-call budget is known
 * to widen the gap between a model's perceived and actual need and to make
 * models overrun their own limits, so the wording asks for at least N when the
 * work allows and explicitly does not cap the total.
 *
 * Cost: 91 tokens per nudge, bounded to {@link MAX_WIDTH_NUDGES_PER_TURN}, so
 * at most ~364 tokens of prefix growth in a turn. Appended rather than spliced,
 * so the existing cached prefix still matches and the growth is charged at the
 * cache-read rate. Against a step that costs ~$0.20 on a 270K prefix that is
 * paid for by removing a single step every few turns.
 */

/**
 * Bounded so a long turn cannot accumulate a column of reminders. Four is
 * enough to catch a run of narrow steps early, where batching still has
 * something to batch, and stops before the nudges themselves become the
 * repetitive context they are trying to reduce.
 */
export const MAX_WIDTH_NUDGES_PER_TURN = 4;

/** Below this step number the target is exploratory width, above it convergent. */
export const WIDTH_TARGET_DESCENT_STEP = 10;

const EARLY_TARGET = 3;
const LATE_TARGET = 2;

/**
 * Suppressed near the step ceiling: the wrap-up warning owns that region and
 * tells the model to stop calling tools, so asking for wider batches there
 * would contradict it in the same prompt.
 */
export const WIDTH_NUDGE_STEP_HEADROOM = 10;

export interface ParallelWidthNudgeInput {
  /** Zero-based index of the step just completed. */
  stepNumber: number;
  /** Tool calls issued by that step. */
  lastStepToolCalls: number;
  /** Nudges already appended in this turn. */
  nudgesUsed: number;
  /** Step ceiling for the turn, so the nudge can stand down near the end. */
  maxSteps: number;
}

export interface ParallelWidthNudge {
  /** Message text to append as a user-role note. */
  text: string;
  /** The width asked for, recorded so the effect can be measured. */
  target: number;
}

export function resolveParallelWidthNudge(
  input: ParallelWidthNudgeInput,
): ParallelWidthNudge | null {
  if (input.nudgesUsed >= MAX_WIDTH_NUDGES_PER_TURN) return null;

  // Only a step that ran exactly one tool is evidence of a missed batch. Zero
  // means the model was writing text, and two or more means it already batched.
  if (input.lastStepToolCalls !== 1) return null;

  if (input.stepNumber >= input.maxSteps - WIDTH_NUDGE_STEP_HEADROOM) {
    return null;
  }

  const target =
    input.stepNumber < WIDTH_TARGET_DESCENT_STEP ? EARLY_TARGET : LATE_TARGET;

  return {
    target,
    text:
      `[SYSTEM NOTE: that step issued 1 tool call. Each step re-sends the ` +
      `entire conversation, so ${target} independent calls in one step cost ` +
      `far less than ${target} steps. Before your next call, ask: could I ` +
      `write the argument lists for the next ${target} actions right now, ` +
      `without seeing any of their results? If yes, issue them together. ` +
      `This is a floor, not a limit on total work — keep anything genuinely ` +
      `sequential sequential.]`,
  };
}
