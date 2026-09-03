/**
 * Post-navigation pacing — gives SPAs time to render before the next agent action.
 */

import type { Page } from "playwright";
import { findPlatformIdForUrl } from "./platformPaprChromeProfile.js";
import { getPlatformConfig, type PlatformId } from "./platformRegistry.js";

const DEFAULT_SETTLE_MS = 1500;
const CONTENT_READY_TIMEOUT_MS = 8_000;
const MIN_MAIN_TEXT_CHARS = 40;

export interface NavigationSettleResult {
  waitedMs: number;
  contentReady: boolean;
}

export function resolvePostNavigationSettleMs(
  url: string,
  platformId?: PlatformId | string,
): number {
  const resolvedPlatformId =
    platformId ?? findPlatformIdForUrl(url) ?? undefined;
  if (resolvedPlatformId) {
    const config = getPlatformConfig(resolvedPlatformId);
    const limits = config?.rateLimits;
    if (limits?.minActionDelayMs) {
      const max = limits.maxActionDelayMs ?? limits.minActionDelayMs + 2000;
      return Math.round((limits.minActionDelayMs + max) / 2);
    }
  }

  if (/linkedin\.com/i.test(url)) {
    return 4000;
  }
  if (/instagram\.com|reddit\.com|x\.com|twitter\.com|facebook\.com/i.test(url)) {
    return 2500;
  }
  return DEFAULT_SETTLE_MS;
}

export async function waitForPlaywrightPageSettle(
  page: Page,
  url: string,
  options?: { platformId?: PlatformId | string; minMs?: number },
): Promise<NavigationSettleResult> {
  const minMs =
    options?.minMs ?? resolvePostNavigationSettleMs(url, options?.platformId);
  const start = Date.now();

  const contentReady = await Promise.all([
    page
      .waitForFunction(
        `() => {
          const mainText = document.querySelector("main")?.innerText?.length ?? 0;
          const bodyText = document.body?.innerText?.length ?? 0;
          return mainText > ${MIN_MAIN_TEXT_CHARS} || bodyText > 80;
        }`,
        { timeout: CONTENT_READY_TIMEOUT_MS },
      )
      .then(() => true)
      .catch(() => false),
    new Promise<void>((resolve) => {
      setTimeout(resolve, minMs);
    }),
  ]).then(([ready]) => ready);

  return {
    waitedMs: Date.now() - start,
    contentReady,
  };
}

export async function sleepForNavigationSettle(
  url: string,
  platformId?: PlatformId | string,
): Promise<NavigationSettleResult> {
  const waitedMs = resolvePostNavigationSettleMs(url, platformId);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, waitedMs);
  });
  return { waitedMs, contentReady: false };
}
