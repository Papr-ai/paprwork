/**
 * Throttle Groq/memory processing for paprwork job bootstrap syncs.
 *
 * Job runs create a new session every tick; enabling process_messages on every
 * POST causes cross-session analysis storms. We still want an occasional summary
 * (aligned with memory server's 3/hour job cross-session cap).
 */

/** Match memory server job-session cross-session rate limit (3/hour). */
export const JOB_SESSION_PROCESS_INTERVAL_MS = 3 * 60 * 60 * 1000;

const lastProcessedAtByJobId = new Map<string, number>();

/** Extract job id from ``job:{jobId}:{runId}`` session ids. */
export function extractJobIdFromChatId(chatId: string): string | null {
  if (!chatId.startsWith("job:")) {
    return null;
  }
  const rest = chatId.slice("job:".length);
  const separator = rest.indexOf(":");
  if (separator === -1) {
    return rest.length > 0 ? rest : null;
  }
  const jobId = rest.slice(0, separator);
  return jobId.length > 0 ? jobId : null;
}

export function shouldEnableJobSessionProcessMessages(
  chatId: string,
  nowMs: number = Date.now(),
  intervalMs: number = JOB_SESSION_PROCESS_INTERVAL_MS,
): boolean {
  const jobId = extractJobIdFromChatId(chatId);
  if (!jobId) {
    return false;
  }

  const lastProcessedAt = lastProcessedAtByJobId.get(jobId) ?? 0;
  if (nowMs - lastProcessedAt < intervalMs) {
    return false;
  }

  lastProcessedAtByJobId.set(jobId, nowMs);
  return true;
}

/** Test helper — reset in-memory throttle state between vitest cases. */
export function resetJobSessionProcessThrottleForTests(): void {
  lastProcessedAtByJobId.clear();
}
