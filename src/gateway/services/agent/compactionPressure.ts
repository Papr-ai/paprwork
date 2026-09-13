/**
 * When mid-turn compaction is worth doing, and how far it should cut.
 *
 * Compaction is not free: a cut result carries a `get_full_tool_result` pointer,
 * and the agent frequently follows it. The recovered copy comes back larger than
 * the original (JSON-escaped inside a metadata envelope), and the fetch costs an
 * extra step — which re-sends the whole context. Measured over Aug–Sep 2026,
 * 98% of 7,561 recovery fetches recovered a result that had never exceeded the
 * fresh ceiling, so the cut that provoked them saved nothing.
 *
 * Two decisions follow, and they are separate questions:
 *
 *   1. **Whether to cut at all** — {@link shouldCompactMidTurn}. There is nothing
 *      to save while the context fits comfortably in the budget.
 *   2. **What to cut** — {@link resolveStaleLengthAllowance}. Short results stay
 *      inline; long ones are cut hard, exactly as before.
 *
 * Together these form a ladder over one turn's context:
 *
 * ```
 *   0 ──────────── 70% ──────────── 100% ── of history token budget
 *   nothing        compact stale     drop oldest history turns
 *                  results          (trimOldestHistoryTurns)
 * ```
 */

/**
 * Fraction of the history token budget above which compaction starts to pay.
 *
 * Deliberately below the thresholds comparable agents use against the *window*
 * (Claude Code ~98%, Codex CLI ≤90%, LCM 0.75) because this ratio applies to the
 * history budget, which is already net of tool schemas and the output reserve —
 * roughly 0.6 of the raw window. It also leaves a band between compaction and
 * `trimOldestHistoryTurns` at 1.0, so the cheaper measure runs first.
 */
export const COMPACTION_PRESSURE_RATIO = 0.7;

/**
 * Stale results at or below this length are left inline rather than replaced
 * with a pointer.
 *
 * Break-even: cutting a result of length L to limit M saves `(L − M)` chars on
 * each remaining step of the turn, and risks one recovery fetch costing a whole
 * step. With a turn's context around 63K tokens, a fetch probability anywhere
 * near the measured rate (one per four tool calls) puts break-even at a few
 * thousand characters. 63% of observed fetches recovered results under 2K, where
 * the cut saves a few hundred characters and the recovery costs thousands.
 *
 * This is the threshold ARC (arXiv 2607.25066) describes as keeping short
 * observations inline and replacing only longer observations with citations.
 */
export const MID_TURN_INLINE_FLOOR_CHARS = 4_000;

/**
 * Whether stale tool results should be compacted for this model call.
 *
 * Returns true when no budget is known: a caller that cannot say how much room
 * is left (the memory-pressure path, or any caller without model context) gets
 * the previous unconditional behaviour rather than a silent reprieve.
 */
export function shouldCompactMidTurn(params: {
  estimatedTokens: number;
  historyTokenBudget?: number;
  /** Overrides the ratio. Only for tests and the settings surface. */
  pressureRatio?: number;
}): boolean {
  const { estimatedTokens, historyTokenBudget } = params;
  if (
    historyTokenBudget === undefined ||
    !Number.isFinite(historyTokenBudget) ||
    historyTokenBudget <= 0
  ) {
    return true;
  }
  const ratio = params.pressureRatio ?? COMPACTION_PRESSURE_RATIO;
  return estimatedTokens >= historyTokenBudget * ratio;
}

/**
 * The length a stale result is allowed to keep.
 *
 * Binary rather than graded, so a genuinely large payload still collapses to its
 * category limit and yields the full saving. Grading everything up to the floor
 * would blunt exactly the cuts that pay for themselves.
 *
 * @param length     current result length in characters
 * @param categoryLimit  the per-tool limit compaction would otherwise apply
 */
export function resolveStaleLengthAllowance(
  length: number,
  categoryLimit: number,
  inlineFloor: number = MID_TURN_INLINE_FLOOR_CHARS,
): number {
  if (categoryLimit >= length) {
    return categoryLimit;
  }
  return length <= inlineFloor ? length : categoryLimit;
}
