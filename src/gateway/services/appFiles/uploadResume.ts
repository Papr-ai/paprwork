/**
 * Durability decisions for large uploads.
 *
 * A 10 GB recording will meet a closed laptop, a dropped VPN and a GCS 503
 * before it finishes. None of those should cost the user 10 GB of re-transfer,
 * and none should cost a second pass of hashing.
 *
 * Everything here is pure. The decisions are the risky part — "is this session
 * still usable", "should we retry this failure" — so they are separated from
 * the acting and tested directly.
 */

/** GCS keeps a resumable session alive for 7 days. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Re-mint a session with this much life left rather than risk it dying
 * mid-upload. A 10 GB upload on a slow link can run for hours.
 */
export const SESSION_MIN_REMAINING_MS = 60 * 60 * 1000;

export interface ResumeCandidate {
  upload_session_uri: string | null;
  session_expires_at: number | null;
  upload_state: string;
  size_bytes: number;
}

export type ResumePlan =
  /** Reuse the stored session; probe GCS for the true offset before sending. */
  | { kind: "resume"; sessionUri: string }
  /** No usable session — request a fresh ticket and start over. */
  | { kind: "restart"; reason: string }
  /** Already done; do nothing. */
  | { kind: "done" };

/**
 * Decide whether an interrupted upload can pick up where it left off.
 *
 * Deliberately conservative: a wrong "resume" wastes a round-trip and then
 * fails confusingly, whereas a wrong "restart" only costs bandwidth we were
 * prepared to spend anyway.
 */
export function planResume(
  row: ResumeCandidate,
  now: number = Date.now(),
): ResumePlan {
  if (row.upload_state === "verified") return { kind: "done" };

  if (!row.upload_session_uri) {
    return { kind: "restart", reason: "no stored upload session" };
  }

  if (row.session_expires_at === null) {
    // A session we cannot date is a session we cannot trust to outlive the
    // upload. Treating it as expired is the cheap, safe answer.
    return { kind: "restart", reason: "session has no recorded expiry" };
  }

  const remaining = row.session_expires_at - now;
  if (remaining <= 0) {
    return { kind: "restart", reason: "upload session expired" };
  }
  if (remaining < SESSION_MIN_REMAINING_MS) {
    // Starting a multi-hour upload on a session with minutes left just moves
    // the failure to the worst possible moment: near the end.
    return { kind: "restart", reason: "upload session expires too soon" };
  }

  return { kind: "resume", sessionUri: row.upload_session_uri };
}

/** Transient failures worth retrying; anything else is a real error. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
};

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Delay before attempt N, exponential with full jitter.
 *
 * Jitter matters more than it looks: without it, every chunk of every
 * concurrent upload retries on the same schedule and hammers GCS in waves
 * exactly when it is already struggling.
 *
 * `random` is injectable so the tests can assert bounds rather than guess.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.round(exponential * random());
}

/** Should this attempt be retried, given the policy and what went wrong? */
export function shouldRetry(
  attempt: number,
  status: number | null,
  policy: RetryPolicy = DEFAULT_RETRY,
): boolean {
  if (attempt >= policy.maxAttempts) return false;
  // A null status means the request never got an answer — a dropped
  // connection. That is the most retryable failure there is.
  if (status === null) return true;
  return isRetryableStatus(status);
}

export interface CachedHash {
  size_bytes: number;
  mtime_ms: number;
  sha256: string;
}

/**
 * Is a cached hash still valid for this file?
 *
 * Size plus mtime is the standard cheap proxy for "unchanged". It can be
 * fooled by a same-size edit within the mtime resolution, which is why this is
 * only ever an optimisation: the server verifies the stored object's size and
 * MD5 at commit time regardless.
 */
export function isHashCacheValid(
  cached: CachedHash | null | undefined,
  actual: { size: number; mtimeMs: number },
): boolean {
  if (!cached) return false;
  return (
    cached.size_bytes === actual.size &&
    Math.floor(cached.mtime_ms) === Math.floor(actual.mtimeMs)
  );
}
