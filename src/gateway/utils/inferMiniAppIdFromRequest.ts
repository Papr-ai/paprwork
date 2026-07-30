/**
 * Infer mini-app ID from browser requests serving /apps/{uuid}/… iframes.
 * Used when mini-app API calls omit appId (fork-safe, no hardcoding).
 */

import type { IncomingHttpHeaders } from "node:http";

const MINI_APP_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPS_PATH_UUID =
  /\/apps\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export interface ResolveMiniAppIdResult {
  appId: string | undefined;
  error?: string;
  status?: number;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    return headerValue(value[0]);
  }
  return undefined;
}

/** Extract mini-app UUID from a gateway URL path (/apps/{uuid}/…). */
export function inferMiniAppIdFromUrl(urlString: string): string | undefined {
  try {
    const url = new URL(urlString);
    const match = url.pathname.match(APPS_PATH_UUID);
    const candidate = match?.[1];
    if (!candidate || !MINI_APP_UUID.test(candidate)) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

/** Prefer Referer (includes app path); Origin is host-only and not used. */
export function inferMiniAppIdFromRequestHeaders(
  headers: IncomingHttpHeaders,
): string | undefined {
  const referer = headerValue(headers.referer);
  if (referer) {
    const fromReferer = inferMiniAppIdFromUrl(referer);
    if (fromReferer) {
      return fromReferer;
    }
  }
  return undefined;
}

/**
 * Resolve appId from explicit body/query param or Referer inference.
 * When both are present they must match (prevents cross-app DB access).
 */
export function resolveMiniAppIdFromRequest(
  explicitAppId: string | undefined,
  headers: IncomingHttpHeaders,
): ResolveMiniAppIdResult {
  const explicit = explicitAppId?.trim() || undefined;
  const inferred = inferMiniAppIdFromRequestHeaders(headers);

  if (explicit && inferred && explicit.toLowerCase() !== inferred.toLowerCase()) {
    return {
      appId: undefined,
      error: "appId does not match the requesting mini-app",
      status: 403,
    };
  }

  const appId = explicit ?? inferred;
  if (!appId) {
    return {
      appId: undefined,
      error: "appId is required (or open the app in Local preview)",
      status: 400,
    };
  }

  if (!MINI_APP_UUID.test(appId)) {
    return {
      appId: undefined,
      error: "appId must be a valid UUID",
      status: 400,
    };
  }

  return { appId };
}
