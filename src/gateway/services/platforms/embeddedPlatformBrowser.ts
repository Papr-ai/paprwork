/**
 * Shared helpers for the in-app platform browser (embedded Electron fallback when Google Chrome is not installed).
 */

import type { PlatformId } from "./platformRegistry.js";
import { getPlatformConfig } from "./platformRegistry.js";
import { isPlatformBrowserBridgeAvailable } from "../../utils/platformBrowserBridge.js";
import { isCloudAgentGatewayMode } from "../../../core/utils/paprRoot.js";

export function isEmbeddedPlatformBrowserSupported(platformId: string): platformId is PlatformId {
  if (!getPlatformConfig(platformId)) {
    return false;
  }
  if (isCloudAgentGatewayMode() || process.env.PLAYWRIGHT_DOCKER === "1") {
    return false;
  }
  return isPlatformBrowserBridgeAvailable();
}

export function getPlatformCookieDomains(platformId: PlatformId): string[] {
  const config = getPlatformConfig(platformId);
  if (!config) {
    return [];
  }
  const domains = new Set<string>();
  domains.add(config.cookieDomain.replace(/^\./, ""));
  if (config.additionalDomains) {
    for (const domain of config.additionalDomains) {
      domains.add(domain.replace(/^\./, ""));
    }
  }
  return [...domains];
}
