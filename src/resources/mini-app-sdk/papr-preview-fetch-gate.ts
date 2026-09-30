/**
 * Pause same-origin /api/* reads while the preview tab is backgrounded.
 *
 * Paprwork keeps LRU-mounted iframes alive for fast tab switch; this gate stops
 * hidden previews from hammering the gateway with DB queries.
 *
 * WHICH CALLS PAUSE — by path, not by method. Measured against the installed
 * apps, nearly every read is a POST carrying a JSON body, so a method rule
 * defers nothing and folds nothing: it is dead code against real traffic. The
 * gateway already draws the line we need, rejecting anything but SELECT on
 * these endpoints, so the path is the part that carries the meaning.
 *
 * Everything else runs unpaused — writes, jobs, bash, any path not on the list.
 * A write issued while hidden is work someone asked for; holding it until the
 * tab is looked at again would be worse than letting it through, and failing it
 * would lose it.
 *
 * FOLDING happens AT ENQUEUE, keyed on path + body. Folding only at flush
 * leaves one entry per call, so a poller still grows the queue without bound
 * and the cap is spent evicting a request's own duplicates. A poller that
 * queued the same query 600 times issues one network call and every waiter is
 * settled from a clone of that response.
 *
 * THE CAP bounds distinct requests. Past it a request is passed straight
 * through rather than queued: the gate stops pausing, which is the behaviour
 * before it existed. It is never rejected. v2.6.0 rejected a queue it judged
 * stale and v2.6.1 removed that a day later — "callers expect these promises to
 * settle on return" — because a mini-app awaiting fetch has no reason to expect
 * an AbortError and hangs or crashes on one. Degrading to unpaused is
 * recoverable; a rejection is not. The one exception is eviction, where the
 * frame is going away and an unsettled promise leaks the caller's continuation.
 *
 * This script must run before any app script or the app captures the native
 * fetch and never sees the gate — see injectMiniAppPreviewFetchGate, which
 * inlines it into <head> for that reason.
 */
import type { PreviewPhase } from "../../core/types/rendererPerformance.js";

/**
 * Endpoints the gateway itself guarantees are read-only (SELECT/WITH only, or
 * GET). Adding a path here without that guarantee would defer a mutation.
 */
const DEFERRABLE_READ_PATHS = new Set([
  "/api/db/query",
  "/api/db/batch",
  "/api/db/query-batch",
  "/api/db/read-batch",
  "/api/db/schema",
]);

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
    __paprPreviewPhase?: PreviewPhase;
  }
}

interface FetchWaiter {
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
}

interface QueuedFetch {
  /** Folding identity, or null when the request must be replayed on its own. */
  key: string | null;
  input: RequestInfo | URL;
  init?: RequestInit;
  /** Every caller folded into this one request. Always at least one. */
  waiters: FetchWaiter[];
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseSameOriginApiUrl(input: RequestInfo | URL): URL | null {
  try {
    const parsed = new URL(resolveRequestUrl(input), window.location.href);
    if (parsed.origin !== window.location.origin) return null;
    return parsed.pathname.startsWith("/api/") ? parsed : null;
  } catch {
    return null;
  }
}

function resolveRequestMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && input !== null && "method" in input)
    return String((input as Request).method).toUpperCase();
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
  if (!source) return "";
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
 * The body is part of the key because these reads carry their query in it —
 * two POSTs to /api/db/query are the same request only if they ask the same
 * thing. A body we cannot read as a string (FormData, a stream, a Request
 * object) is not assumed equal to anything, and a request carrying a signal
 * never folds: one waiter aborting must not cancel the others.
 */
export function coalesceKeyForRequest(
  url: URL,
  input: RequestInfo | URL,
  init?: RequestInit,
): string | null {
  if (typeof input !== "string" && !(input instanceof URL)) return null;
  if (init?.signal) return null;
  const body = init?.body;
  if (body != null && typeof body !== "string") return null;
  const method = resolveRequestMethod(input, init);
  return `${method} ${url.pathname}${url.search} ${body ?? ""} ${fingerprintHeaders(input, init)}`;
}

export function installPreviewFetchGate(): (() => void) | undefined {
  if (
    typeof window === "undefined" ||
    typeof window.fetch !== "function" ||
    window.__paprPreviewFetchGateInstalled
  )
    return;
  window.__paprPreviewFetchGateInstalled = true;

  // iframe.name is readable before app scripts even across origins, so the
  // phase is known at boot. The host supplies it without changing src (which
  // would reload on every tab switch). Waiting for papr:preview-hidden instead
  // would race the app's own first fetch, and the hidden app would win.
  let phase: PreviewPhase =
    window.name === "papr-preview:hidden" ? "hidden" : "visible";
  window.__paprPreviewPhase = phase;

  const documentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let allowedApi = 0,
    deferredApi = 0,
    passedThroughApi = 0,
    allowedOther = 0;
  const report = (sequence?: number) => {
    if (window.parent === window) return;
    window.parent.postMessage(
      {
        type: "papr:preview-gate-report",
        sequence,
        gate: {
          documentId,
          phase,
          allowedApi,
          deferredApi,
          passedThroughApi,
          allowedOther,
        },
      },
      "*",
    );
  };

  const queue: QueuedFetch[] = [];
  /** Folding index over `queue`, kept in step with it on every mutation. */
  const queuedByKey = new Map<string, QueuedFetch>();

  function clearQueue(): QueuedFetch[] {
    queuedByKey.clear();
    return queue.splice(0);
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
        for (const waiter of item.waiters) waiter.reject(error);
      },
    );
  }

  function flushQueuedFetches(): void {
    for (const item of clearQueue()) settleQueued(item);
  }

  function rejectQueuedFetches(reason: string): void {
    const error = new DOMException(reason, "AbortError");
    for (const item of clearQueue())
      for (const waiter of item.waiters) waiter.reject(error);
  }

  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const type = event.data?.type;
    if (type === "papr:preview-hidden") phase = "hidden";
    else if (type === "papr:preview-visible") {
      phase = "visible";
      flushQueuedFetches();
    } else if (type === "papr:preview-evicting") {
      phase = "evicting";
      rejectQueuedFetches("Preview evicted");
    } else return;
    window.__paprPreviewPhase = phase;
    report(event.data?.sequence);
  };
  window.addEventListener("message", onMessage);

  const originalFetch = window.fetch;
  const nativeFetch = originalFetch.bind(window);
  const wrapped: typeof fetch = (input, init) => {
    const url = parseSameOriginApiUrl(input);
    if (url === null) {
      allowedOther += 1;
      return nativeFetch(input, init);
    }
    if (phase === "visible") {
      allowedApi += 1;
      return nativeFetch(input, init);
    }
    if (!DEFERRABLE_READ_PATHS.has(url.pathname)) {
      passedThroughApi += 1;
      return nativeFetch(input, init);
    }

    const key = coalesceKeyForRequest(url, input, init);

    // Fold into an identical request already waiting. This is what bounds the
    // queue against a poller: 600 identical polls are one entry, so the cap
    // below is never spent evicting a request's own duplicates.
    if (key !== null) {
      const existing = queuedByKey.get(key);
      if (existing) {
        deferredApi += 1;
        return new Promise((resolve, reject) => {
          existing.waiters.push({ resolve, reject });
        });
      }
    }

    // Too much genuine variety to hold. Run it now rather than rejecting it:
    // an unpaused fetch is the pre-gate behaviour and the app copes, whereas
    // an AbortError it never asked for is unrecoverable (see header).
    if (queue.length >= MAX_QUEUED_FETCHES) {
      passedThroughApi += 1;
      return nativeFetch(input, init);
    }

    deferredApi += 1;
    return new Promise((resolve, reject) => {
      const item: QueuedFetch = {
        key,
        input,
        init,
        waiters: [{ resolve, reject }],
      };
      queue.push(item);
      if (key !== null) queuedByKey.set(key, item);
    });
  };
  window.fetch = wrapped;
  report(); // Host replies with current state; does not depend on iframe load.

  return () => {
    window.removeEventListener("message", onMessage);
    if (window.fetch === wrapped) window.fetch = originalFetch;
    // The pause is over, so anything still held must run — leaving a waiter
    // unsettled would hang whichever app call is awaiting it.
    flushQueuedFetches();
    delete window.__paprPreviewFetchGateInstalled;
    delete window.__paprPreviewPhase;
  };
}

export const disposePreviewFetchGate = installPreviewFetchGate();
