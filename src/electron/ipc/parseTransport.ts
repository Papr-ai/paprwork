/**
 * Hardened transport for Parse GraphQL / Papr platform HTTP calls.
 *
 * Node's global fetch keeps sockets alive but places no cap on concurrent
 * connections per origin, so a burst of callers opens a socket each and
 * server.papr.ai sheds them as ECONNRESET. Retrying those resets then produces
 * more load than the original burst, so a degraded server never recovers.
 *
 * This module bounds that behaviour:
 *   - a semaphore caps in-flight requests per origin
 *   - identical concurrent reads share one request (coalescing)
 *   - every request has a timeout, so a hung socket cannot be held open
 *   - retries use jittered backoff, so parallel callers do not retry in lockstep
 *   - a circuit breaker fails fast while the origin is unhealthy
 */

/** Sockets we allow against one origin at a time. */
const MAX_CONCURRENT_PER_ORIGIN = 4;

/** A single attempt may not exceed this. Parse reads are small; slow means broken. */
export const PARSE_REQUEST_TIMEOUT_MS = 20_000;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;

/** Consecutive failures before we stop calling the origin. */
const CIRCUIT_FAILURE_THRESHOLD = 6;
/** How long the circuit stays open before a single probe is allowed through. */
const CIRCUIT_OPEN_MS = 30_000;

export class ParseCircuitOpenError extends Error {
  constructor(origin: string, retryInMs: number) {
    super(
      `${origin} is temporarily unreachable (circuit open, retrying in ` +
        `${Math.ceil(retryInMs / 1000)}s)`,
    );
    this.name = "ParseCircuitOpenError";
  }
}

interface OriginState {
  active: number;
  queue: Array<() => void>;
  consecutiveFailures: number;
  openedAt: number | null;
  /** Set while a probe request is testing whether the origin recovered. */
  probing: boolean;
}

const origins = new Map<string, OriginState>();

function getOriginState(origin: string): OriginState {
  let state = origins.get(origin);
  if (!state) {
    state = {
      active: 0,
      queue: [],
      consecutiveFailures: 0,
      openedAt: null,
      probing: false,
    };
    origins.set(origin, state);
  }
  return state;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

async function acquire(state: OriginState): Promise<void> {
  if (state.active < MAX_CONCURRENT_PER_ORIGIN) {
    state.active += 1;
    return;
  }
  await new Promise<void>((resolve) => state.queue.push(resolve));
  state.active += 1;
}

function release(state: OriginState): void {
  state.active -= 1;
  const next = state.queue.shift();
  if (next) next();
}

/**
 * Errors worth retrying: connection-level failures and 5xx. Anything else
 * (auth, validation, GraphQL errors) will fail the same way on a retry.
 */
export function isTransientTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && "cause" in error ? String(error.cause) : "";
  const combined = `${message} ${cause}`;
  return (
    combined.includes("Invalid server state") ||
    combined.includes("ECONNRESET") ||
    combined.includes("ECONNREFUSED") ||
    combined.includes("EPIPE") ||
    combined.includes("ETIMEDOUT") ||
    combined.includes("fetch failed") ||
    combined.includes("The operation was aborted") ||
    combined.includes("TimeoutError") ||
    combined.includes("502") ||
    combined.includes("503") ||
    combined.includes("504") ||
    /error: 5\d\d/.test(combined)
  );
}

/** Circuit state check. Lets one probe through once the open window elapses. */
function checkCircuit(origin: string, state: OriginState): void {
  if (state.openedAt === null) return;

  const elapsed = Date.now() - state.openedAt;
  if (elapsed < CIRCUIT_OPEN_MS) {
    throw new ParseCircuitOpenError(origin, CIRCUIT_OPEN_MS - elapsed);
  }

  // Window elapsed: allow a single probe, keep everyone else failing fast so a
  // recovering server is not hit by the whole backlog at once.
  if (state.probing) {
    throw new ParseCircuitOpenError(origin, CIRCUIT_OPEN_MS);
  }
  state.probing = true;
}

function recordSuccess(origin: string, state: OriginState): void {
  if (state.openedAt !== null) {
    console.log(`[ParseTransport] ${origin} recovered, closing circuit`);
  }
  state.consecutiveFailures = 0;
  state.openedAt = null;
  state.probing = false;
}

function recordFailure(origin: string, state: OriginState): void {
  state.consecutiveFailures += 1;
  state.probing = false;

  if (
    state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD &&
    state.openedAt === null
  ) {
    state.openedAt = Date.now();
    console.warn(
      `[ParseTransport] ${origin} failed ${state.consecutiveFailures} times in a row; ` +
        `pausing requests for ${CIRCUIT_OPEN_MS / 1000}s`,
    );
  } else if (state.openedAt !== null) {
    // Probe failed — restart the open window rather than probing every call.
    state.openedAt = Date.now();
  }
}

function jitteredBackoff(attempt: number): number {
  const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  // Full jitter: spreads parallel callers instead of having them retry together.
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface ParseFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  /** Attempts including the first. Set to 1 for non-idempotent writes. */
  maxAttempts?: number;
}

/**
 * Perform an HTTP request through the bounded pool, with retry and circuit
 * breaking. Resolves with the Response for the caller to interpret.
 */
export async function parseFetch(
  url: string,
  options: ParseFetchOptions = {},
): Promise<Response> {
  const origin = originOf(url);
  const state = getOriginState(origin);
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? PARSE_REQUEST_TIMEOUT_MS;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    checkCircuit(origin, state);
    await acquire(state);

    try {
      const response = await fetch(url, {
        method: options.method ?? "POST",
        headers: options.headers,
        body: options.body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      // 5xx counts against the circuit; 4xx is the caller's problem, not the
      // origin's health, so it closes the circuit like any other response.
      if (response.status >= 500) {
        recordFailure(origin, state);
        if (attempt < maxAttempts) {
          const text = await response.text().catch(() => "");
          lastError = new Error(`Parse error: ${response.status} ${text}`);
          await sleep(jitteredBackoff(attempt));
          continue;
        }
      } else {
        recordSuccess(origin, state);
      }

      return response;
    } catch (error) {
      lastError = error;
      recordFailure(origin, state);

      if (!isTransientTransportError(error) || attempt === maxAttempts) {
        throw error;
      }
      await sleep(jitteredBackoff(attempt));
    } finally {
      release(state);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Request to ${origin} failed`);
}

/** In-flight reads, keyed by caller-supplied identity, for coalescing. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Share one in-flight request between identical concurrent callers.
 *
 * The profile/workspace/billing refreshes fan out from several independent
 * renderer triggers at once. Without coalescing each trigger issues its own
 * round trip for the same data.
 */
export function coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** Test/diagnostic hook — drops circuit + coalescing state. */
export function resetParseTransportState(): void {
  origins.clear();
  inFlight.clear();
}
