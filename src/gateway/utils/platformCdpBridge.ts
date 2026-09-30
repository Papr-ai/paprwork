import type { JobRecord } from "../services/jobs/types.js";
import { isGoogleChromeInstalled } from "../services/platforms/platformChromeEnv.js";
import { shouldUseRealChromeProfile } from "../services/platforms/platformAgentBrowser.js";
import {
  isPlatformBrowserBridgeAvailable,
  requestPlatformBrowser,
} from "./platformBrowserBridge.js";

/** Maps job `requirements` tags to Platform Connections platform ids. */
export const PLATFORM_REQUIREMENT_MAP: Record<string, string> = {
  "linkedin-api": "linkedin",
  "instagram-api": "instagram",
  "reddit-api": "reddit",
  "facebook-api": "facebook",
  "x-api": "x",
  "twitter-api": "x",
};

export const DEFAULT_PLATFORM_CDP_PORT = 9222;

export function resolvePlatformCdpUrl(): string {
  if (process.env.PAPR_PLATFORM_CDP_DISABLE === "1") {
    return "";
  }
  if (process.env.LINKEDIN_CHROME_CDP_URL) {
    return process.env.LINKEDIN_CHROME_CDP_URL;
  }
  if (process.env.PAPR_PLATFORM_CDP_URL) {
    return process.env.PAPR_PLATFORM_CDP_URL;
  }
  const port = process.env.PAPR_PLATFORM_CDP_PORT ?? String(DEFAULT_PLATFORM_CDP_PORT);
  return `http://127.0.0.1:${port}`;
}

export function platformIdsFromRequirements(requirements?: string[]): string[] {
  if (!requirements?.length) {
    return [];
  }
  const ids = new Set<string>();
  for (const requirement of requirements) {
    const mapped = PLATFORM_REQUIREMENT_MAP[requirement];
    if (mapped) {
      ids.add(mapped);
      continue;
    }
    if (requirement.startsWith("platform:")) {
      const platformId = requirement.slice("platform:".length).trim();
      if (platformId.length > 0) {
        ids.add(platformId);
      }
    }
  }
  return [...ids];
}

export function jobNeedsPlatformCdp(job: Pick<JobRecord, "requirements">): boolean {
  return platformIdsFromRequirements(job.requirements).length > 0;
}

interface EnsureCdpData {
  platformId?: string;
  cdpUrl?: string | null;
  webContentsId?: number;
  url?: string;
  partition?: string;
}

/**
 * Ensures platform CDP is available for Python/Node jobs (Playwright connect_over_cdp).
 * Prefers Papr-managed real Chrome on port 9222 (LinkedIn CDP jobs).
 * Falls back to embedded Electron tab CDP only when Google Chrome is not installed.
 */
export async function ensurePlatformCdpEnvForJob(
  job: Pick<JobRecord, "requirements">,
): Promise<Record<string, string>> {
  const platformIds = platformIdsFromRequirements(job.requirements);
  if (platformIds.length === 0) {
    return {};
  }

  const platformId = platformIds[0];
  const fallbackCdpUrl = resolvePlatformCdpUrl();

  if (shouldUseRealChromeProfile(platformId) || isGoogleChromeInstalled()) {
    const { ensureRealChromeCdp } = await import(
      "../services/platforms/platformAgentBrowser.js"
    );
    const { getPlatformSessionService } = await import(
      "../services/platforms/PlatformSessionService.js"
    );
    await getPlatformSessionService().initialize();
    const cdpUrl = await ensureRealChromeCdp(platformId);
    return {
      PAPR_PLATFORM_CDP_URL: cdpUrl,
      PAPR_PLATFORM_ID: platformId,
      LINKEDIN_CHROME_CDP_URL: cdpUrl,
    };
  }

  if (!isPlatformBrowserBridgeAvailable()) {
    throw new Error(
      "Platform browser CDP requires Papr desktop with Google Chrome installed, " +
        "or the embedded platform browser fallback.",
    );
  }

  if (!fallbackCdpUrl) {
    throw new Error(
      "Platform CDP is disabled (PAPR_PLATFORM_CDP_DISABLE=1). " +
        "Remove the flag or use agent jobs with prepare_browser instead.",
    );
  }

  const response = await requestPlatformBrowser(
    {
      action: "ensure_cdp",
      payload: { platformId },
    },
    process,
    30_000,
  );

  if (!response.success) {
    throw new Error(
      response.error ??
        `Failed to prepare embedded ${platformId} browser for CDP`,
    );
  }

  const data = response.data as EnsureCdpData | undefined;
  const cdpUrl =
    typeof data?.cdpUrl === "string" && data.cdpUrl.length > 0
      ? data.cdpUrl
      : fallbackCdpUrl;

  const env: Record<string, string> = {
    PAPR_PLATFORM_CDP_URL: cdpUrl,
    PAPR_PLATFORM_ID: platformId,
    LINKEDIN_CHROME_CDP_URL: cdpUrl,
  };

  if (typeof data?.webContentsId === "number") {
    env.PAPR_PLATFORM_WEB_CONTENTS_ID = String(data.webContentsId);
  }
  if (typeof data?.url === "string" && data.url.length > 0) {
    env.PAPR_PLATFORM_BROWSER_URL = data.url;
  }
  if (typeof data?.partition === "string" && data.partition.length > 0) {
    env.PAPR_PLATFORM_PARTITION = data.partition;
  }

  return env;
}
