/**
 * Helpers for converting Chrome / keychain cookies into Playwright format.
 */

import type { Cookie } from "playwright";
import type { PlatformConfig } from "./platformRegistry.js";

/** Shape returned by chrome-cookies-secure with format "puppeteer" */
export interface ChromePuppeteerCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  Secure?: boolean;
  HttpOnly?: boolean;
}

const CHROMIUM_EPOCH_OFFSET = 11_644_473_600_000_000;

/** Convert Chromium microsecond timestamp to Playwright Unix seconds (-1 = session). */
export function chromiumExpiresToPlaywright(expiresUtc: number | undefined): number {
  if (!expiresUtc || expiresUtc <= 0) {
    return -1;
  }
  const unixSeconds = Math.floor(expiresUtc / 1_000_000 - CHROMIUM_EPOCH_OFFSET / 1_000_000);
  return unixSeconds > 0 ? unixSeconds : -1;
}

export function chromePuppeteerToPlaywright(cookie: ChromePuppeteerCookie): Cookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    expires: chromiumExpiresToPlaywright(cookie.expires),
    httpOnly: Boolean(cookie.HttpOnly),
    secure: Boolean(cookie.Secure),
    sameSite: "Lax",
  };
}

export function getPlaywrightCookieDomain(
  config: PlatformConfig,
  cookieName: string,
): string {
  const overrides = config.cookieDomainOverrides;
  if (overrides) {
    const direct = overrides[cookieName];
    if (direct) return direct;
    const lower = overrides[cookieName.toLowerCase()];
    if (lower) return lower;
  }
  return config.cookieDomain;
}

export function buildPlaywrightCookiesFromKeychainValues(
  config: PlatformConfig,
  values: Record<string, string>,
): Cookie[] {
  return Object.entries(values).map(([name, value]) => ({
    name,
    value,
    domain: getPlaywrightCookieDomain(config, name),
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  }));
}

export function filterRequiredPlaywrightCookies(
  cookies: Cookie[],
  config: PlatformConfig,
): Cookie[] {
  const required = new Set(config.requiredCookies.map((n) => n.toLowerCase()));
  return cookies.filter((c) => required.has(c.name.toLowerCase()));
}

export function hasRequiredPlaywrightCookies(
  cookies: Cookie[],
  requiredCookies: string[],
): boolean {
  const names = new Set(cookies.map((c) => c.name.toLowerCase()));
  return requiredCookies.every((name) => names.has(name.toLowerCase()));
}

export function repairPlaywrightCookieDomains(
  cookies: Cookie[],
  config: PlatformConfig,
  keychainValues: Record<string, string>,
): { cookies: Cookie[]; repaired: boolean } {
  const { cookies: valueSynced, valuesChanged } = syncPlaywrightCookieValuesFromKeychain(
    cookies,
    keychainValues,
  );

  if (!config.cookieDomainOverrides || Object.keys(keychainValues).length === 0) {
    return { cookies: valueSynced, repaired: valuesChanged };
  }

  for (const [name, expectedDomain] of Object.entries(config.cookieDomainOverrides)) {
    const cookie = valueSynced.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (cookie && cookie.domain !== expectedDomain) {
      return {
        cookies: buildPlaywrightCookiesFromKeychainValues(config, {
          ...Object.fromEntries(valueSynced.map((c) => [c.name, c.value])),
          ...keychainValues,
        }),
        repaired: true,
      };
    }
  }

  return { cookies: valueSynced, repaired: valuesChanged };
}

/** Prefer fresher keychain values over stale cookies.json entries (SessionKeeper updates keychain first). */
export function syncPlaywrightCookieValuesFromKeychain(
  cookies: Cookie[],
  keychainValues: Record<string, string>,
): { cookies: Cookie[]; valuesChanged: boolean } {
  if (Object.keys(keychainValues).length === 0) {
    return { cookies, valuesChanged: false };
  }

  let valuesChanged = false;
  const synced = cookies.map((cookie) => {
    const keychainValue =
      keychainValues[cookie.name] ??
      keychainValues[cookie.name.toLowerCase()] ??
      keychainValues[
        Object.keys(keychainValues).find(
          (key) => key.toLowerCase() === cookie.name.toLowerCase(),
        ) ?? ""
      ];
    if (keychainValue && keychainValue !== cookie.value) {
      valuesChanged = true;
      return { ...cookie, value: keychainValue };
    }
    return cookie;
  });

  return { cookies: synced, valuesChanged };
}
