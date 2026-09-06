/**
 * Pause same-origin /api/* fetch while the preview tab is backgrounded.
 *
 * Paprwork keeps LRU-mounted iframes alive for fast tab switch; this gate
 * stops hidden previews from hammering the gateway with DB/job queries.
 * Stale queued requests are dropped (not flushed) when the tab becomes visible.
 */

type PreviewPhase = "hidden" | "visible" | "evicting";

declare global {
  interface Window {
    __paprPreviewFetchGateInstalled?: boolean;
  }
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
  const MAX_FLUSH_ON_VISIBLE = 5;
  const queue: Array<{
    run: () => void;
    reject: (reason: unknown) => void;
  }> = [];

  function rejectQueuedFetches(reason: string): void {
    const pending = queue.splice(0);
    const error = new DOMException(reason, "AbortError");
    for (const item of pending) {
      item.reject(error);
    }
  }

  function flushQueuedFetches(): void {
    const pending = queue.splice(0);
    for (const item of pending) {
      item.run();
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
      // A tab switch back often has 1–3 bootstrap queries (paint/load).
      // Flush those so the app is not stuck on a never-resolving promise.
      // Larger queues are stale background polls — reject so callers can bail.
      if (queue.length <= MAX_FLUSH_ON_VISIBLE) {
        flushQueuedFetches();
      } else {
        rejectQueuedFetches("Preview became visible — stale background fetches aborted");
      }
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
    return new Promise((resolve, reject) => {
      queue.push({
        run: () => {
          nativeFetch(input, init).then(resolve, reject);
        },
        reject,
      });
    });
  };
}

installPreviewFetchGate();
