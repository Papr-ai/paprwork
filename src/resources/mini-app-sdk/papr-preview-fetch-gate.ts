/**
 * Pause same-origin /api/* fetch while the preview tab is backgrounded.
 *
 * Paprwork keeps LRU-mounted iframes alive for fast tab switch; this gate
 * stops hidden previews from hammering the gateway with DB/job queries.
 * While hidden, same-origin /api fetches fail fast (no queue buildup from pollers).
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

  window.addEventListener("message", (event: MessageEvent) => {
    const type = event.data?.type;
    if (type === "papr:preview-hidden") {
      phase = "hidden";
      return;
    }
    if (type === "papr:preview-visible") {
      phase = "visible";
      return;
    }
    if (type === "papr:preview-evicting") {
      phase = "evicting";
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
    return Promise.reject(
      new DOMException("Preview backgrounded", "AbortError"),
    );
  };
}

installPreviewFetchGate();
