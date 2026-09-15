/**
 * Normalize failed same-origin /api/* responses so mini-apps see JSON { error }.
 * Must load before papr-preview-fetch-gate (which wraps window.fetch).
 */

import {
  formatMiniAppHttpErrorMessage,
} from "../../core/utils/miniAppHttpError.js";

declare global {
  interface Window {
    __paprApiErrorFetchInstalled?: boolean;
  }
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.pathname + input.search;
  }
  try {
    const parsed = new URL(input.url);
    return parsed.pathname + parsed.search;
  } catch {
    return input.url;
  }
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

export function installMiniAppApiErrorFetch(): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return;
  }
  if (window.__paprApiErrorFetchInstalled) {
    return;
  }
  window.__paprApiErrorFetchInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await nativeFetch(input, init);
    if (response.ok || !isSameOriginApiRequest(input)) {
      return response;
    }

    const path = resolveRequestUrl(input);
    let bodyText = "";
    try {
      bodyText = await response.clone().text();
    } catch {
      bodyText = "";
    }

    const message = formatMiniAppHttpErrorMessage(
      response.status,
      bodyText,
      path,
    );
    return new Response(JSON.stringify({ error: message }), {
      status: response.status,
      statusText: response.statusText,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };
}

installMiniAppApiErrorFetch();
