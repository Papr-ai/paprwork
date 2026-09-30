/**
 * LinkedIn session validation helpers.
 *
 * Session health is determined from real browser tab URLs only — never by replaying
 * cookies over bare HTTP (PerimeterX treats that as credential reuse and kills sessions).
 */

import type { PlatformConfig } from "./platformRegistry.js";
import { isAuthenticatedPlatformUrl, isLoggedOutPlatformUrl } from "./platformSessionUrl.js";

export const LINKEDIN_SESSION_REJECTED_MESSAGE =
  "LinkedIn rejected the saved session. Reconnect LinkedIn in Settings → Platforms, then run again.";

export const LINKEDIN_PROBE_NETWORK_ERROR_MESSAGE =
  "Could not verify LinkedIn session (network error). Your login may still work — try Check now or Reconnect.";

/** Legacy probe failures stored in platform-sessions.json — treat as transient when re-displaying. */
export function isTransientLinkedInProbeError(reason: string): boolean {
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error|timed out|apiRequestContext\.get/i.test(
    reason,
  );
}

/** Strip Playwright call logs and cookie headers before showing errors in UI. */
export function sanitizeLinkedInProbeErrorForDisplay(reason: string): string {
  if (isTransientLinkedInProbeError(reason)) {
    return LINKEDIN_PROBE_NETWORK_ERROR_MESSAGE;
  }

  let text = reason.replace(/\u001b\[[0-9;]*m/g, "");
  text = text.replace(/\s*- cookie:.*$/gims, "");
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? text;
  const trimmed = firstLine.trim();
  if (trimmed.length > 220) {
    return `${trimmed.slice(0, 220)}…`;
  }
  return trimmed || LINKEDIN_SESSION_REJECTED_MESSAGE;
}

export interface LinkedInSessionProbeResult {
  accepted: boolean;
  finalUrl: string;
  status: number;
  reason?: string;
}

const MIN_FEED_BODY_CHARS = 500;

/** Classify HTTP probe results — kept for unit tests only; not used at runtime. */
export function classifyLinkedInProbeResult(input: {
  finalUrl: string;
  status: number;
  locationHeader?: string;
  bodySnippet: string;
}): LinkedInSessionProbeResult {
  const { finalUrl, status, locationHeader, bodySnippet } = input;

  if (/uas\/login|session_redirect|authwall/i.test(finalUrl)) {
    return {
      accepted: false,
      finalUrl,
      status,
      reason: "redirected to login",
    };
  }

  if (status >= 300 && status < 400) {
    const location = locationHeader ?? "";
    if (location.includes("/feed/") || /\/feed\/?$/i.test(finalUrl)) {
      return {
        accepted: false,
        finalUrl,
        status,
        reason: "feed redirect loop (session rejected)",
      };
    }
    return {
      accepted: false,
      finalUrl,
      status,
      reason: `HTTP ${status} redirect`,
    };
  }

  if (status < 200 || status >= 400) {
    return {
      accepted: false,
      finalUrl,
      status,
      reason: `HTTP ${status}`,
    };
  }

  const snippet = bodySnippet.slice(0, 8000);
  if (/session_redirect|authwall|sign-in|login-form/i.test(snippet)) {
    return {
      accepted: false,
      finalUrl,
      status,
      reason: "login wall in response",
    };
  }

  if (snippet.length < MIN_FEED_BODY_CHARS) {
    return {
      accepted: false,
      finalUrl,
      status,
      reason: "empty feed response",
    };
  }

  return { accepted: true, finalUrl, status };
}

/** True when a real browser tab URL indicates an authenticated LinkedIn session. */
export function isLinkedInSessionAliveFromBrowserUrl(
  url: string | null | undefined,
  config: PlatformConfig,
): boolean {
  if (!url) {
    return false;
  }
  return isAuthenticatedPlatformUrl(url, config) && !isLoggedOutPlatformUrl(url);
}
