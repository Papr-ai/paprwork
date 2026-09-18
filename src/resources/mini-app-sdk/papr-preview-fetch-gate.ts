/**
 * Installed inline before app scripts. Hidden API calls fail immediately;
 * nothing is queued or replayed. In-flight requests are left alone.
 * Metrics count calls through this wrapper, not XHR/SSE or all network traffic.
 */
import type { PreviewPhase } from "../../core/types/rendererPerformance.js";

declare global {
  interface Window {
    __paprPreviewFetchGateInstalled?: boolean;
    __paprPreviewPhase?: PreviewPhase;
  }
}

function isSameOriginApiRequest(input: RequestInfo | URL): boolean {
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const parsed = new URL(raw, window.location.href);
    return (
      parsed.origin === window.location.origin &&
      parsed.pathname.startsWith("/api/")
    );
  } catch {
    return false;
  }
}

export function installPreviewFetchGate(): (() => void) | undefined {
  if (
    typeof window === "undefined" ||
    typeof window.fetch !== "function" ||
    window.__paprPreviewFetchGateInstalled
  )
    return;
  window.__paprPreviewFetchGateInstalled = true;
  // iframe.name is accessible before app scripts even across origins. The host
  // supplies it without changing src (which would reload on every tab switch).
  let phase: PreviewPhase =
    window.name === "papr-preview:hidden" ? "hidden" : "visible";
  window.__paprPreviewPhase = phase;
  const documentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let allowedApi = 0,
    blockedApi = 0,
    allowedOther = 0;
  const report = (sequence?: number) => {
    if (window.parent === window) return;
    window.parent.postMessage(
      {
        type: "papr:preview-gate-report",
        sequence,
        gate: { documentId, phase, allowedApi, blockedApi, allowedOther },
      },
      "*",
    );
  };
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const type = event.data?.type;
    if (type === "papr:preview-hidden") phase = "hidden";
    else if (type === "papr:preview-visible") phase = "visible";
    else if (type === "papr:preview-evicting") phase = "evicting";
    else return;
    window.__paprPreviewPhase = phase;
    report(event.data?.sequence);
  };
  window.addEventListener("message", onMessage);
  const originalFetch = window.fetch;
  const nativeFetch = originalFetch.bind(window);
  const wrapped: typeof fetch = (input, init) => {
    if (!isSameOriginApiRequest(input)) {
      allowedOther += 1;
      return nativeFetch(input, init);
    }
    if (phase !== "visible") {
      blockedApi += 1;
      return Promise.reject(
        new DOMException("Preview backgrounded", "AbortError"),
      );
    }
    allowedApi += 1;
    return nativeFetch(input, init);
  };
  window.fetch = wrapped;
  report(); // Host replies with current state; does not depend on iframe load.
  return () => {
    window.removeEventListener("message", onMessage);
    if (window.fetch === wrapped) window.fetch = originalFetch;
    delete window.__paprPreviewFetchGateInstalled;
    delete window.__paprPreviewPhase;
  };
}

export const disposePreviewFetchGate = installPreviewFetchGate();
