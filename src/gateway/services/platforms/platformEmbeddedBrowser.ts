/**
 * Agent automation via the in-app platform browser tab (Electron WebContentsView).
 */

import type { PlatformId } from "./platformRegistry.js";
import { getPlatformConfig } from "./platformRegistry.js";
import { requestPlatformBrowser } from "../../utils/platformBrowserBridge.js";
import {
  isLoggedOutPlatformUrl,
  platformNavigationUrlsMatch,
  shouldSkipPlatformLandingHop,
} from "./platformSessionUrl.js";
import { getPlatformSessionService } from "./PlatformSessionService.js";
import {
  isEmbeddedPlatformBrowserSupported,
  getPlatformCookieDomains,
} from "./embeddedPlatformBrowser.js";
import { shouldUseRealChromeProfile } from "./platformAgentBrowser.js";
import { allowsEmbeddedPlatformSession } from "./platformConnectPolicy.js";

export interface EmbeddedPlatformPrepareResult {
  success: boolean;
  url: string;
  title: string;
  message: string;
  error?: string;
}

export function shouldUseEmbeddedPlatformBrowser(
  platformId: string,
): platformId is PlatformId {
  if (!allowsEmbeddedPlatformSession(platformId as PlatformId)) {
    return false;
  }
  if (shouldUseRealChromeProfile(platformId)) {
    return false;
  }
  return isEmbeddedPlatformBrowserSupported(platformId);
}

function isLoggedOutUrl(url: string): boolean {
  return isLoggedOutPlatformUrl(url);
}

export async function prepareEmbeddedPlatformSession(
  platformId: PlatformId,
  targetUrl?: string,
): Promise<EmbeddedPlatformPrepareResult> {
  const config = getPlatformConfig(platformId);
  if (!config) {
    return {
      success: false,
      url: "",
      title: "",
      message: `Unknown platform: ${platformId}`,
      error: `Unknown platform: ${platformId}`,
    };
  }

  const destination = targetUrl ?? config.homeUrl;
  const landingUrl = config.prepareNavigationUrl ?? destination;

  const stateBefore = await requestPlatformBrowser({
    action: "get_state",
    payload: { platformId },
  });
  const urlBefore =
    stateBefore.success && stateBefore.data
      ? String((stateBefore.data as { url?: string }).url ?? "")
      : "";

  const skipLanding =
    urlBefore.length > 0 &&
    shouldSkipPlatformLandingHop(urlBefore, destination, config) &&
    (platformNavigationUrlsMatch(urlBefore, destination) ||
      (landingUrl !== destination &&
        shouldSkipPlatformLandingHop(urlBefore, landingUrl, config)));

  if (!skipLanding) {
    const ensureResponse = await requestPlatformBrowser({
      action: "ensure",
      payload: { platformId, url: landingUrl },
    });

    if (!ensureResponse.success) {
      return {
        success: false,
        url: "",
        title: "",
        message: `Failed to open ${config.name} in Papr.`,
        error: ensureResponse.error ?? "ensure failed",
      };
    }
  }

  if (
    destination !== landingUrl &&
    !platformNavigationUrlsMatch(urlBefore, destination)
  ) {
    const navResponse = await requestPlatformBrowser({
      action: "navigate",
      payload: { platformId, url: destination },
    });
    if (!navResponse.success) {
      return {
        success: false,
        url: "",
        title: "",
        message: `Failed to navigate ${config.name}.`,
        error: navResponse.error ?? "navigate failed",
      };
    }
  }

  const stateResponse = await requestPlatformBrowser({
    action: "get_state",
    payload: { platformId },
  });
  const state = (stateResponse.data ?? {}) as { url?: string; title?: string };
  const currentUrl = state.url ?? "";
  const title = state.title ?? "";

  if (isLoggedOutUrl(currentUrl)) {
    await requestPlatformBrowser({
      action: "show_tab",
      payload: { platformId },
    });
    return {
      success: false,
      url: currentUrl,
      title,
      message: `${config.name} session expired — log in using the ${config.name} tab in Papr.`,
      error:
        `Session expired. Open Settings → Platform Connections → Connect, or log in in Papr Chrome.`,
    };
  }

  await syncEmbeddedCookiesToKeychain(platformId);

  return {
    success: true,
    url: currentUrl,
    title,
    message:
      `${config.name} tab ready inside Papr. ` +
      `Use browser_snapshot to read the page, browser_navigate for other URLs.`,
  };
}

export async function syncEmbeddedCookiesToKeychain(
  platformId: PlatformId,
): Promise<void> {
  if (!allowsEmbeddedPlatformSession(platformId)) {
    return;
  }

  const config = getPlatformConfig(platformId);
  if (!config) {
    return;
  }

  const response = await requestPlatformBrowser({
    action: "extract_cookies",
    payload: { platformId, cookieDomains: getPlatformCookieDomains(platformId) },
  });
  if (!response.success || !response.data) {
    return;
  }

  const data = response.data as {
    cookies: Array<{ name: string; value: string }>;
  };
  const values: Record<string, string> = {};
  if (config.isCustom) {
    for (const cookie of data.cookies) {
      if (cookie.value) {
        values[cookie.name] = cookie.value;
      }
    }
  } else {
    for (const cookieName of config.requiredCookies) {
      const match = data.cookies.find(
        (c) => c.name.toLowerCase() === cookieName.toLowerCase(),
      );
      if (match?.value) {
        values[cookieName] = match.value;
      }
    }
  }

  const hasSession =
    config.isCustom
      ? Object.keys(values).length > 0
      : config.requiredCookies.every((name) => values[name]);

  if (hasSession) {
    const sessionService = getPlatformSessionService();
    await sessionService.persistEmbeddedSession(platformId, config, values, data.cookies);
  }
}
