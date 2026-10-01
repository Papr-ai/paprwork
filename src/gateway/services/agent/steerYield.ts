/**
 * Follow-up steering: "pause at the next tool boundary".
 *
 * When the user sends a message while the agent is mid-turn, we do not abort
 * the stream (that throws away an in-flight tool call and leaves an
 * `interrupted` row that auto-continue then fights over). Instead the UI asks
 * the running turn to *yield*: the loop finishes the step it is on — tools
 * included — and ends the turn cleanly. The queued message then sends as the
 * next turn, lands in the transcript directly below the work so far, and the
 * agent continues below it with the new context.
 *
 * This is the same contract as Codex CLI's Enter-to-steer, docker-agent's
 * `/steer`, and Hermes' `/steer`: inject at a tool boundary, never mid-token
 * ("Are Large Reasoning Models Interruptible?", arXiv:2510.11713 — quality
 * drops sharply when context changes mid-reasoning).
 */

const yieldRequests = new Set<string>();
/** chatId → when the yield was requested; the next turn is a steered follow-up. */
const pendingSteerFollowUps = new Map<string, number>();
/** A follow-up removed from the queue should not tag a much later turn. */
const STEER_FOLLOW_UP_TTL_MS = 10 * 60_000;

/** Ask the running turn for `chatId` to stop after its current step. */
export function requestYieldAtBoundary(chatId: string, now = Date.now()): void {
  yieldRequests.add(chatId);
  pendingSteerFollowUps.set(chatId, now);
}

/**
 * Called once when a new (non-retry) turn starts. Clears any stale yield so it
 * cannot stop the follow-up itself, and reports whether this turn carries a
 * message the user sent while the previous turn was working.
 */
export function consumeTurnStart(
  chatId: string,
  opts: { hiddenContinue?: boolean; now?: number } = {},
): { steerFollowUp: boolean } {
  const now = opts.now ?? Date.now();
  yieldRequests.delete(chatId);
  // An auto-continue is not the user's follow-up; leave the mark for it.
  if (opts.hiddenContinue) return { steerFollowUp: false };
  const requestedAt = pendingSteerFollowUps.get(chatId);
  pendingSteerFollowUps.delete(chatId);
  return {
    steerFollowUp:
      requestedAt !== undefined && now - requestedAt <= STEER_FOLLOW_UP_TTL_MS,
  };
}

export function isYieldRequested(chatId: string): boolean {
  return yieldRequests.has(chatId);
}

export function clearYieldRequest(chatId: string): void {
  yieldRequests.delete(chatId);
}

/**
 * Model-only note for the turn that carries a steered follow-up. Never
 * persisted — the transcript shows exactly what the user typed.
 */
export const STEER_FOLLOW_UP_NOTE =
  "[SYSTEM NOTE: The user sent the message above while you were still working. " +
  "You paused at a tool boundary to read it. Take it into account and carry on " +
  "from where you stopped — do not restart or repeat finished work — unless the " +
  "user is clearly redirecting you to something else.]";

/**
 * AI SDK `stopWhen` hook: true once a yield was requested and at least one
 * step has completed (so tool results from that step are kept).
 */
export function shouldStopForYield(chatId: string, stepCount: number): boolean {
  return stepCount > 0 && isYieldRequested(chatId);
}

/**
 * Insert the steer note directly after the last user message. A fixed
 * position (rather than appending at the tail every step) keeps the prompt
 * prefix stable across steps, so provider prompt caching still hits.
 * Returns a new array; idempotent if the note is already present.
 */
export function withSteerNote<T extends { role: string; content: unknown }>(
  messages: T[],
  makeNote: (text: string) => T = (text) =>
    ({ role: "user", content: text }) as T,
): T[] {
  if (messages.some((m) => m.content === STEER_FOLLOW_UP_NOTE)) {
    return messages;
  }
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return messages;
  const next = messages.slice();
  next.splice(lastUser + 1, 0, makeNote(STEER_FOLLOW_UP_NOTE));
  return next;
}
