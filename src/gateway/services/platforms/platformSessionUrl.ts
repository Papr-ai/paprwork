/**
 * URL helpers for platform session connect / prepare flows.
 */

import type { PlatformConfig } from "./platformRegistry.js";

export function isLoggedOutPlatformUrl(url: string): boolean {
  return (
    /\/login(?:\/|$|\?|#)/i.test(url) ||
    /\/signin(?:\/|$|\?|#)/i.test(url) ||
    /\/sign-in(?:\/|$|\?|#)/i.test(url) ||
    /\/checkpoint(?:\/|$|\?|#)/i.test(url) ||
    /\/authwall/i.test(url) ||
    /\/oauth/i.test(url) ||
    /\/sso(?:\/|$|\?|#)/i.test(url)
  );
}

export function isAuthenticatedPlatformUrl(url: string, config: PlatformConfig): boolean {
  if (!url) {
    return false;
  }

  if (config.isCustom && config.originHost) {
    return url.includes(config.originHost) && !isLoggedOutPlatformUrl(url);
  }

  return config.successUrlPattern.test(url);
}

/** Normalize platform URLs so trailing slashes / hash do not force redundant reloads. */
export function normalizePlatformNavigationUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

export function platformNavigationUrlsMatch(current: string, target: string): boolean {
  return normalizePlatformNavigationUrl(current) === normalizePlatformNavigationUrl(target);
}

/**
 * When Papr Chrome is already on an authenticated page, skip the landing hop
 * (e.g. linkedin.com/ before /in/foo) — it causes visible double reloads.
 */
export function shouldSkipPlatformLandingHop(
  currentUrl: string,
  destination: string,
  config: PlatformConfig,
): boolean {
  if (!currentUrl || currentUrl === "about:blank") {
    return false;
  }
  if (isLoggedOutPlatformUrl(currentUrl)) {
    return false;
  }
  if (!isAuthenticatedPlatformUrl(currentUrl, config)) {
    return false;
  }

  try {
    const currentHost = new URL(currentUrl).hostname;
    const destHost = new URL(destination).hostname;
    return currentHost === destHost;
  } catch {
    return false;
  }
}
