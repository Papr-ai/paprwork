/**
 * Soft tip when bash/curl/python replays Platform Connections HTTP.
 * Does not block — appends guidance to use browser_* tools instead.
 */

const CURL_OR_WGET = /\b(curl|wget)\b/i;
const PYTHON_HTTP =
  /\b(python3?|requests\.|httpx\.|urllib\.request|aiohttp)\b/i;

const PLATFORM_HOST =
  /\b(?:www\.)?(linkedin|instagram|facebook|reddit|tiktok)\.com\b|\b(?:api\.)?twitter\.com\b|\bx\.com\b|\bvoyager-api\.linkedin\.com\b|\b(?:[a-z0-9-]+\.)*linkedin\.com\b|\baccounts\.google\.com\b/i;

const VOYAGER_PATH = /\bvoyager[/\-]|graphql.*linkedin|\/voyager\/api\//i;

const PLATFORM_COOKIE_KEY =
  /\$\{(?:LINKEDIN|INSTAGRAM|FACEBOOK|REDDIT|TWITTER|TIKTOK|SITE_[A-Z0-9_]+)_[A-Z0-9_]+\}/;

const PLATFORM_COOKIE_HEADER =
  /(?:-H|--header|-b|--cookie)\s+['"]?(?:[^'"]*(?:li_at|JSESSIONID|linkedin|csrfToken)[^'"]*)['"]?/i;

export interface PlatformBrowserBashTip {
  message: string;
  useInstead: string[];
}

export function detectPlatformBrowserBashTip(
  command: string,
): PlatformBrowserBashTip | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (
    /\blocalhost\b|\b127\.0\.0\.1\b|:18789\b|\$PAPR_HOME|\$APP_DB|\$JOB_DB/.test(
      trimmed,
    ) &&
    !PLATFORM_HOST.test(trimmed)
  ) {
    return null;
  }

  const usesCurl = CURL_OR_WGET.test(trimmed);
  const usesPythonHttp = PYTHON_HTTP.test(trimmed) && PLATFORM_HOST.test(trimmed);

  if (!usesCurl && !usesPythonHttp) {
    return null;
  }

  const hitsPlatformHost = PLATFORM_HOST.test(trimmed);
  const hitsVoyager = VOYAGER_PATH.test(trimmed);
  const hitsPlatformKey = PLATFORM_COOKIE_KEY.test(trimmed);
  const hitsCookieHeader = PLATFORM_COOKIE_HEADER.test(trimmed);

  if (
    !hitsPlatformHost &&
    !hitsVoyager &&
    !hitsPlatformKey &&
    !hitsCookieHeader
  ) {
    return null;
  }

  return {
    message:
      "Tip: for LinkedIn/social/Platform Connections, prefer prepare_browser + browser_* tools — " +
      "browser_snapshot, browser_network_logs, browser_console_logs, browser_click. " +
      "curl/cookie replay often returns empty results (stale CSRF/query IDs).",
    useInstead: [
      "browser_snapshot({})",
      "browser_network_logs({ limit: 100 })",
      "browser_console_logs({ limit: 50 })",
    ],
  };
}

export function formatPlatformBrowserBashTip(tip: PlatformBrowserBashTip): string {
  return `\n\n=== Platform browser tip ===\n${tip.message}\n${tip.useInstead.map((s) => `- ${s}`).join("\n")}\n`;
}

/** Detect manual auth checkpoint pages from snapshot HTML (passkey, 2FA, OAuth). */
export function detectManualAuthCheckpoint(html: string): string | null {
  const lower = html.toLowerCase();
  const signals = [
    "verifying it's you",
    "complete sign-in using your passkey",
    "try another way",
    "two-step verification",
    "enter your password",
    "confirm it's you",
    "check your phone",
    "authenticator app",
  ];
  const hit = signals.find((s) => lower.includes(s));
  if (!hit) return null;

  return (
    "Manual sign-in step detected (passkey / 2FA / OAuth). " +
    "If using embedded Electron fallback (Chrome not installed), passkeys cannot appear — tell the user to click Try another way → password or SMS. " +
    "If using Papr-managed Chrome (normal desktop flow), passkeys and OAuth work in that window — ask the user to complete sign-in there, then call browser_snapshot again."
  );
}

export function formatManualAuthCheckpointTip(tip: string): string {
  return `\n\n=== Manual auth required ===\n${tip}\n`;
}
