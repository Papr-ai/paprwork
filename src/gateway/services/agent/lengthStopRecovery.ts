/**
 * Recovery for a step that hit the output cap while still thinking.
 *
 * Seen live on Opus 5.5 over OAuth (8 turns, every one at exactly 40,192
 * output tokens): asked to build several files at once, the model spends the
 * whole step planning and the cap cuts it off before the first tool call or
 * word of text. The turn then ends on a "no reply" note, and "continue"
 * replays the same plan into the same cap.
 *
 * Extended thinking rules out forcing a tool call (`tool_choice: any` is not
 * allowed with thinking on), so the recovery step gets the two levers that do
 * work: a direct instruction to start building in small pieces, and low
 * effort so the plan it already made is not re-derived from scratch.
 */

export const LENGTH_STOP_RECOVERY_NUDGE =
  "[SYSTEM: You ran out of output while planning, before making any tool call. " +
  "Your plan is not visible and nothing was built. Start building now: " +
  "one file per tool call, keep each file small, and do not re-plan the whole task first.]";

/** One recovery per turn: a second cap-out is a different problem. */
export const MAX_LENGTH_STOP_RECOVERIES_PER_TURN = 1;

export function shouldRecoverFromLengthStop(args: {
  finishReason: string | null;
  stepText: string;
  toolCallCount: number;
  recoveriesUsed: number;
  aborted: boolean;
  textOnlyStep: boolean;
}): boolean {
  return (
    args.finishReason === "length" &&
    args.stepText.trim().length === 0 &&
    args.toolCallCount === 0 &&
    args.recoveriesUsed < MAX_LENGTH_STOP_RECOVERIES_PER_TURN &&
    !args.aborted &&
    !args.textOnlyStep
  );
}

type PayloadHook = (
  params: Record<string, unknown>,
  model: unknown,
) =>
  | Record<string, unknown>
  | undefined
  | Promise<Record<string, unknown> | undefined>;

/**
 * Same stream options with reasoning turned to low: `reasoning` for budget
 * models and OpenAI, and the adaptive `output_config.effort` that the
 * Anthropic override writes into the payload.
 */
export function withLowEffort<
  T extends { reasoning?: string; onPayload?: PayloadHook },
>(options: T): T {
  const inner = options.onPayload;
  return {
    ...options,
    ...(options.reasoning ? { reasoning: "low" } : {}),
    onPayload: async (params: Record<string, unknown>, model: unknown) => {
      const patched = (inner ? await inner(params, model) : undefined) ?? params;
      const config = patched.output_config;
      if (config && typeof config === "object" && "effort" in config) {
        return { ...patched, output_config: { ...config, effort: "low" } };
      }
      return patched;
    },
  };
}
