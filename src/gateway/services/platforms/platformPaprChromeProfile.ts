/**
 * Shared Papr-managed Chrome profile — one browser, multiple platform tabs.
 */

import { join } from "node:path";
import type { Page } from "playwright";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import {
  type PlatformConfig,
  type PlatformId,
  getAllPlatformIds,
  getPlatformConfig,
} from "./platformRegistry.js";
import { isAuthenticatedPlatformUrl, isLoggedOutPlatformUrl } from "./platformSessionUrl.js";

export const PAPR_CHROME_PROFILE_DIR_NAME = "_papr-chrome";

export function getSharedPaprChromeUserDataDir(): string {
  return join(getPaprRoot(), "browser-profiles", PAPR_CHROME_PROFILE_DIR_NAME);
}

export function hostnameMatchesPlatform(hostname: string, config: PlatformConfig): boolean {
  const normalized = hostname.toLowerCase();
  const domain = config.cookieDomain.replace(/^\./, "").toLowerCase();
  if (normalized === domain || normalized.endsWith(`.${domain}`)) {
    return true;
  }
  if (config.originHost && normalized === config.originHost.toLowerCase()) {
    return true;
  }
  for (const extra of config.additionalDomains ?? []) {
    const d = extra.replace(/^\./, "").toLowerCase();
    if (normalized === d || normalized.endsWith(`.${d}`)) {
      return true;
    }
  }
  return false;
}

export function findPlatformIdForUrl(url: string): PlatformId | null {
  if (!url || url === "about:blank") {
    return null;
  }
  try {
    const hostname = new URL(url).hostname;
    for (const platformId of getAllPlatformIds()) {
      const config = getPlatformConfig(platformId);
      if (config && hostnameMatchesPlatform(hostname, config)) {
        return platformId;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function pickBestPageForPlatform(pages: Page[], config: PlatformConfig): Page | null {
  const matching = pages.filter((page) => {
    if (page.isClosed()) {
      return false;
    }
    try {
      return hostnameMatchesPlatform(new URL(page.url()).hostname, config);
    } catch {
      return false;
    }
  });
  if (matching.length === 0) {
    return null;
  }

  const authenticated = matching.find((page) =>
    isAuthenticatedPlatformUrl(page.url(), config),
  );
  if (authenticated) {
    return authenticated;
  }

  const nonLogin = matching.find((page) => !isLoggedOutPlatformUrl(page.url()));
  return nonLogin ?? matching[0] ?? null;
}
