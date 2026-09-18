/**
 * Pause same-origin /api/* fetch while the preview tab is backgrounded.
 *
 * Paprwork keeps LRU-mounted iframes alive for fast tab switch; this gate
 * stops hidden previews from hammering the gateway with DB/job queries.
 *
 * On return to visible, queued GETs are COALESCED by request identity rather
 * than replayed one-for-one: a poller that queued the same URL 600 times issues
 * one network call, and every waiter is settled from a clone of that response.
 * Replaying all of them fired the whole backlog at the exact moment the user
 * was waiting for the tab to paint. Coalescing settles every promise at the
 * cost of one request. Non-GET requests are never coalesced — two queued
 * mutations are not interchangeable.
 *
 * Identical requests are folded together AT ENQUEUE, not at flush. Folding only
 * at flush leaves the queue holding one entry per call, so a poller still grows
 * it without bound and a cap would be spent evicting a request's own duplicates.
 *
 * The queue is bounded by DISTINCT requests. Past the cap a request is passed
 * straight through instead of being queued: the gate stops pausing, which is
 * the behaviour before it existed. It is never rejected. v2.6.0 rejected a
 * queue it judged stale and v2.6.1 removed that a day later — "callers expect
 * these promises to settle on return" — because a mini-app awaiting fetch has
 * no reason to expect an AbortError and hangs or crashes on one. Degrading to
 * unpaused is recoverable; a rejection is not.
 *
 * This script must run before any app script or the app captures the native
 * fetch and never sees the gate — see injectMiniAppPreviewFetchGate, which
 * injects it as a blocking classic script in <head> for that reason.
 */

type PreviewPhase = "hidden" | "visible" | "evicting";

/**
 * Distinct queued requests held while hidden. Past this, requests run unpaused.
 *
 * Distinct, because identical polls fold into one entry — so this bounds real
 * variety, not call volume, and an app has to ask for 64 different things while
 * backgrounded to reach it.
 */
const MAX_QUEUED_FETCHES = 64;

declare global {
  interface Window {
    __paprPreviewFetchGateInstalled?: boolean;
  }
}

interface FetchWaiter {
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
}

interface QueuedFetch {
  /** Coalescing identity, or null when the request must not be coalesced. */
  key: string | null;
  input: RequestInfo | URL;
  init?: RequestInit;
  /** Every caller folded into this one request. Always at least one. */
  waiters: FetchWaiter[];
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function isSameOriginApiRequest(input: RequestInfo | URL): boolean {
  try {
    const raw = resolveRequestUrl(input);
    if (raw.startsWith("/api/")) {
      return true;
    }
    const parsed = new URL(raw, window.location.href);
    return (
      parsed.origin === window.location.origin &&
      parsed.pathname.startsWith("/api/")
    );
  } catch {
    return false;
  }
}

function resolveRequestMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }
  if (typeof input === "object" && input !== null && "method" in input) {
    return String((input as Request).method).toUpperCase();
  }
  return "GET";
}

function fingerprintHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  const source =
    init?.headers ??
    (typeof input === "object" && input !== null && "headers" in input
      ? (input as Request).headers
      : undefined);
  if (!source) {
    return "";
  }
  try {
    const entries: Array<[string, string]> = [];
    new Headers(source as HeadersInit).forEach((value, name) => {
      entries.push([name, value]);
    });
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return entries.map(([name, value]) => `${name}:${value}`).join("|");
  } catch {
    // Unfingerprintable headers must not be assumed equal to anything.
    return `\u0000${Math.random()}`;
  }
}

/**
 * Identity two queued requests must share to be answered by one network call,
 * or null when the request must be replayed on its own.
 *
 * Only safe, bodyless, signal-free GETs coalesce. A request carrying a signal
 * is excluded because one waiter aborting must not cancel the others, and
 * headers are part of the key because two GETs of the same URL with different
 * headers can legitimately return different responses.
 */
export function coalesceKeyForRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): string | null {
  const method = resolveRequestMethod(input, init);
  if (method !== "GET" && method !== "HEAD") {
    return null;
  }
  if (init?.body != null) {
    return null;
  }
  if (init?.signal) {
    return null;
  }
  if (typeof input === "object" && input !== null && "signal" in input) {
    if ((input as Request).signal) {
      return null;
    }
  }
  return `${method} ${resolveRequestUrl(input)} ${fingerprintHeaders(input, init)}`;
}

export function installPreviewFetchGate(): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return;
  }
  if (window.__paprPreviewFetchGateInstalled) {
    return;
  }
  window.__paprPreviewFetchGateInstalled = true;

  // Default visible — same as papr-preview-lifecycle.ts. The parent sends
  // papr:preview-hidden only after backgrounding; until then fetches must run
  // during iframe bootstrap or the app stays on "Loading…" forever.
  let phase: PreviewPhase = "visible";
  const queue: QueuedFetch[] = [];
  /** Coalescing index over `queue`, kept in step with it on every mutation. */
  const queuedByKey = new Map<string, QueuedFetch>();

  function clearQueue(): QueuedFetch[] {
    queuedByKey.clear();
    return queue.splice(0);
  }

  function rejectQueuedFetches(reason: string): void {
    const error = new DOMException(reason, "AbortError");
    for (const item of clearQueue()) {
      for (const waiter of item.waiters) {
        waiter.reject(error);
      }
    }
  }

  function settleQueued(item: QueuedFetch): void {
    nativeFetch(item.input, item.init).then(
      (response) => {
        // Clone before anyone reads: consumers run in later microtasks, so the
        // body is still undisturbed here. The last waiter takes the original so
        // we never leave an unread clone buffering.
        for (let i = 0; i < item.waiters.length; i += 1) {
          const isLast = i === item.waiters.length - 1;
          item.waiters[i].resolve(isLast ? response : response.clone());
        }
      },
      (error) => {
        for (const waiter of item.waiters) {
          waiter.reject(error);
        }
      },
    );
  }

  function flushQueuedFetches(): void {
    for (const item of clearQueue()) {
      settleQueued(item);
    }
  }

  window.addEventListener("message", (event: MessageEvent) => {
    const type = event.data?.type;
    if (type === "papr:preview-hidden") {
      phase = "hidden";
      return;
    }
    if (type === "papr:preview-visible") {
      phase = "visible";
      flushQueuedFetches();
      return;
    }
    if (type === "papr:preview-evicting") {
      phase = "evicting";
      rejectQueuedFetches("Preview evicted");
    }
  });

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (phase === "visible" || !isSameOriginApiRequest(input)) {
      return nativeFetch(input, init);
    }

    const key = coalesceKeyForRequest(input, init);

    // Fold into an identical request already waiting. This is what bounds the
    // queue against a poller: 600 identical polls are one entry, so the cap
    // below is never spent evicting a request's own duplicates.
    if (key !== null) {
      const existing = queuedByKey.get(key);
      if (existing) {
        return new Promise((resolve, reject) => {
          existing.waiters.push({ resolve, reject });
        });
      }
    }

    // Too much genuine variety to hold. Run it now rather than rejecting it:
    // an unpaused fetch is the pre-gate behaviour and the app copes, whereas
    // an AbortError it never asked for is unrecoverable (see header).
    if (queue.length >= MAX_QUEUED_FETCHES) {
      return nativeFetch(input, init);
    }

    return new Promise((resolve, reject) => {
      const item: QueuedFetch = {
        key,
        input,
        init,
        waiters: [{ resolve, reject }],
      };
      queue.push(item);
      if (key !== null) {
        queuedByKey.set(key, item);
      }
    });
  };
}

installPreviewFetchGate();
