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

/** Bound how long we wait on agent:stop before starting a new user send. */
export const AGENT_INTERRUPT_TIMEOUT_MS = 8_000;
