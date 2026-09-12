/**
 * The turn that is happening right now.
 *
 * Everything else in the context meter reads `messages` — which is written
 * once, after the turn is over. That is correct for billing and useless for
 * feedback: a 107-step turn showed the user a frozen ring and four em-dashes
 * for nine minutes, then jumped. The numbers the meter wants already exist
 * mid-flight as locals inside the streaming loop (`cumulativeSteps`,
 * `peakContextTokens`); this module is the only thing missing, a place to put
 * them where a read can find them.
 *
 * In-memory and per-process on purpose. A live turn is not history — if the
 * gateway restarts mid-turn the turn is gone too, and persisting a snapshot of
 * it would leave a permanent "in progress" row that nothing ever closes.
 */

export interface LiveTurnSnapshot {
  chatId: string;
  model: string;
  /** Identity of this turn, so a late `finally` cannot end the next one. */
  token: number;
  startedAt: number;
  /** Steps the provider has finished, not steps attempted. */
  steps: number;
  toolCalls: number;
  /**
   * Size of the largest single request so far — the same measurement
   * `turn_peak_context_tokens` stores when the turn ends, so the ring does not
   * jump when live hands over to recorded.
   */
  peakContextTokens: number;
  /** Cumulative billed prompt across steps, for a mid-turn cost estimate. */
  billedPromptTokens: number;
  billedCompletionTokens: number;
}

const liveTurns = new Map<string, LiveTurnSnapshot>();

/**
 * Returns a token identifying this turn. `endLiveTurn` requires it, for the
 * same reason `clearStreamingStateIfOwner` exists: the auto-send queue can
 * start the next turn before the previous one finishes unwinding, and an
 * unconditional delete in the loser's `finally` would erase the winner's
 * live state — leaving a running turn with a dead meter.
 */
export function beginLiveTurn(chatId: string, model: string): number {
  const token = ++turnToken;
  liveTurns.set(chatId, {
    chatId,
    model,
    token,
    startedAt: Date.now(),
    steps: 0,
    toolCalls: 0,
    peakContextTokens: 0,
    billedPromptTokens: 0,
    billedCompletionTokens: 0,
  });
  return token;
}

let turnToken = 0;

/**
 * Monotonic by construction: every numeric field only ever moves up within a
 * turn. A continuation stream restarts its own counters from zero (see
 * turnUsageAccounting), and letting that reset the live snapshot would make
 * the ring visibly fall backwards mid-turn.
 */
export function updateLiveTurn(
  chatId: string,
  patch: Partial<
    Omit<LiveTurnSnapshot, "chatId" | "model" | "startedAt" | "token">
  >,
): void {
  const current = liveTurns.get(chatId);
  if (!current) return;
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== "number") continue;
    const field = key as keyof LiveTurnSnapshot;
    const previous = current[field];
    if (typeof previous === "number" && value > previous) {
      (current as unknown as Record<string, number>)[field] = value;
    }
  }
}

export function endLiveTurn(chatId: string, token: number): void {
  if (liveTurns.get(chatId)?.token !== token) return;
  liveTurns.delete(chatId);
}

export function readLiveTurn(chatId: string): LiveTurnSnapshot | null {
  return liveTurns.get(chatId) ?? null;
}

/**
 * Guards against a turn that died without unwinding — a hard provider abort or
 * a swallowed throw leaves the entry behind, and a stuck "live" meter is worse
 * than a stale one because it claims to be current. Nothing in this codebase
 * runs a single turn for an hour.
 */
const LIVE_TURN_MAX_AGE_MS = 60 * 60 * 1000;

export function readFreshLiveTurn(chatId: string): LiveTurnSnapshot | null {
  const turn = liveTurns.get(chatId);
  if (!turn) return null;
  if (Date.now() - turn.startedAt > LIVE_TURN_MAX_AGE_MS) {
    liveTurns.delete(chatId);
    return null;
  }
  return turn;
}
