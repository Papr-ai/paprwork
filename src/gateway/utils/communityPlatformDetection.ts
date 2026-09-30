/**
 * Derive Community catalog platform badges from IPC usage + OS signals.
 *
 * Cloud handles: chat.open, vault keys, /api/db/*, /api/jobs/run (sandbox),
 * /api/app/backend/*, and cloud agent Playwright. Desktop is required only for
 * Electron paprAPI (except chat.open), hardcoded local gateway URLs, attaching
 * to the user's local Chrome via CDP, and native OS integrations (Swift, etc.).
 */

import type { CloudCompatibilityFinding } from "../../core/types/cloudAppCompatibility.js";
import {
  mergePlatformSignals,
  platformsFromSignals,
  scanFileContentsForPlatformSignals,
  scanTextForPlatformSignals,
  type CatalogPlatform,
  type PlatformSignals,
} from "./appPlatformDetection.js";
import {
  getDesktopOnlyPaprApiMethods,
  extractPaprApiInvokeMethods,
} from "./paprApiCloudSafety.js";

/** Signals that full functionality needs Paprwork desktop (not apps.papr.ai). */
const DESKTOP_ONLY_CATEGORIES = new Set([
  "papr-api",
  "localhost-gateway",
  "chrome-automation",
]);

export interface CommunityPlatformReport {
  platform: CatalogPlatform[];
  requiresDesktopForFullFunctionality: boolean;
  /** paprAPI methods that are not cloud-safe (excludes chat.open). */
  desktopOnlyPaprApiMethods: string[];
  osSignals: PlatformSignals;
}

export function deriveCommunityPlatform(input: {
  fileContents: Map<string, string>;
  jobs: Array<{ command?: string; type: string }>;
  compatibilityFindings: CloudCompatibilityFinding[];
}): CommunityPlatformReport {
  const desktopOnlyPaprApiMethods = new Set<string>();
  for (const content of input.fileContents.values()) {
    for (const method of getDesktopOnlyPaprApiMethods(content)) {
      desktopOnlyPaprApiMethods.add(method);
    }
  }

  const hasDesktopOnlyFinding = input.compatibilityFindings.some((finding) =>
    DESKTOP_ONLY_CATEGORIES.has(finding.category),
  );
  const hasSwiftJob = input.jobs.some((job) => job.type === "swift");

  const requiresDesktopForFullFunctionality =
    desktopOnlyPaprApiMethods.size > 0 ||
    hasDesktopOnlyFinding ||
    hasSwiftJob;

  let osSignals = scanFileContentsForPlatformSignals(input.fileContents);
  for (const job of input.jobs) {
    if (job.type === "swift") {
      osSignals = mergePlatformSignals(osSignals, {
        macos: true,
        windows: false,
        linux: false,
      });
    }
    if (job.command) {
      osSignals = mergePlatformSignals(
        osSignals,
        scanTextForPlatformSignals(job.command),
      );
    }
  }

  const platform: CatalogPlatform[] = requiresDesktopForFullFunctionality
    ? platformsFromSignals(osSignals)
    : ["macos", "windows", "linux"];

  return {
    platform,
    requiresDesktopForFullFunctionality,
    desktopOnlyPaprApiMethods: [...desktopOnlyPaprApiMethods].sort(),
    osSignals,
  };
}

/** Summarize paprAPI usage for compatibility findings / agent guidance. */
export function summarizePaprApiUsage(
  fileContents: Map<string, string>,
): { cloudSafe: string[]; desktopOnly: string[] } {
  const cloudSafe = new Set<string>();
  const desktopOnly = new Set<string>();

  for (const content of fileContents.values()) {
    for (const method of extractPaprApiInvokeMethods(content)) {
      if (method === "chat.open") {
        cloudSafe.add(method);
      } else {
        desktopOnly.add(method);
      }
    }
  }

  return {
    cloudSafe: [...cloudSafe].sort(),
    desktopOnly: [...desktopOnly].sort(),
  };
}
