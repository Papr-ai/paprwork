/** Per-chat send generation — invalidates stale finally/catch from preempted sends. */
export function nextSendGeneration(
  generations: Map<string, number>,
  chatId: string,
): number {
  const next = (generations.get(chatId) ?? 0) + 1;
  generations.set(chatId, next);
  return next;
}

export function isSendGenerationCurrent(
  generations: Map<string, number>,
  chatId: string,
  generation: number,
): boolean {
  return generations.get(chatId) === generation;
}

/**
 * For work started outside `sendMessage` (auto-continue): snapshot with
 * `peekSendGeneration`, then `noSendSince` stays true only while no user send
 * has begun. A hidden continue that runs after a user send replaces that turn
 * and continues the old assistant row above the user's new message.
 */
export function peekSendGeneration(
  generations: Map<string, number>,
  chatId: string,
): number {
  return generations.get(chatId) ?? 0;
}

export function noSendSince(
  generations: Map<string, number>,
  chatId: string,
  snapshot: number,
): boolean {
  return (generations.get(chatId) ?? 0) === snapshot;
}

/** Bound how long we wait on agent:stop before starting a new user send. */
export const AGENT_INTERRUPT_TIMEOUT_MS = 8_000;
