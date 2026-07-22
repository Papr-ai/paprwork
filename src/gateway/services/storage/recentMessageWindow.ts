/**
 * Recent message window after summarization — cache-friendly chunked growth.
 *
 * Grow from MIN to MAX (10→20) as new messages arrive, then snap back to MIN
 * (drop oldest 10) so prefix cache breaks every ~11 messages instead of every turn.
 */

export const RECENT_MESSAGES_MIN = 10;
export const RECENT_MESSAGES_MAX = 20;
/** Growth steps per cycle before snapping back to MIN. */
export const RECENT_MESSAGES_CHUNK = 10;
export const RECENT_MESSAGES_WITHOUT_SUMMARY = 20;

const CYCLE_LENGTH = RECENT_MESSAGES_CHUNK + 1;

/** @deprecated Use RECENT_MESSAGES_MIN — kept for footprint SQL imports */
export const RECENT_MESSAGES_WITH_SUMMARY = RECENT_MESSAGES_MIN;

export function resolveSummaryBaseMessageCount(
  messageCount: number,
  summaryBaseMessageCount: number | null | undefined,
): number {
  if (summaryBaseMessageCount != null) {
    return summaryBaseMessageCount;
  }
  return Math.max(0, messageCount - RECENT_MESSAGES_MIN);
}

/**
 * Ensure the window does not start mid-turn (assistant without preceding user).
 * Expands up to messageCount so the model always sees who asked what.
 */
export function expandRecentMessageLimit(
  messageCount: number,
  requestedLimit: number,
  oldestLoadedRole: string | undefined,
): number {
  if (oldestLoadedRole !== "assistant") {
    return requestedLimit;
  }
  return Math.min(messageCount, requestedLimit + 1);
}

/**
 * Compute how many recent message rows to load when a summary exists.
 *
 * @param currentMessageCount - Total messages in chat (from chats.message_count)
 * @param summaryBaseMessageCount - message_count when summary was last saved
 */
export function computeRecentMessageLimit(
  currentMessageCount: number,
  summaryBaseMessageCount: number | null | undefined,
): number {
  const base = resolveSummaryBaseMessageCount(
    currentMessageCount,
    summaryBaseMessageCount,
  );

  const delta = Math.max(0, currentMessageCount - base);
  if (delta === 0) {
    return RECENT_MESSAGES_MIN;
  }

  const chunk = Math.floor(delta / CYCLE_LENGTH);
  const posInChunk = delta - chunk * CYCLE_LENGTH;

  if (posInChunk === 0) {
    return RECENT_MESSAGES_MIN;
  }

  return Math.min(RECENT_MESSAGES_MAX, RECENT_MESSAGES_MIN + posInChunk);
}
