/**
 * One Papr-managed Chrome window with a dedicated tab per platform.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { BrowserContext, Cookie, Page } from "playwright";
import { type PlatformConfig, type PlatformId, getPlatformConfig } from "./platformRegistry.js";
import {
  buildPlatformCdpUrl,
  isCdpAttachUnsupportedError,
  isChromeUsingUserDataDir,
  isPlatformCdpReady,
  resolvePlatformCdpPort,
  spawnDirectGoogleChrome,
} from "./platformDirectChromeSpawn.js";
import {
  findPlatformIdForUrl,
  getSharedPaprChromeUserDataDir,
  hostnameMatchesPlatform,
  pickBestPageForPlatform,
} from "./platformPaprChromeProfile.js";

const NAVIGATION_TIMEOUT_MS = 60_000;
const CHROME_LAUNCH_TIMEOUT_MS = 30_000;

export interface PaprChromeBrowser {
  context: BrowserContext;
  cdpAttached: boolean;
  platformTabs: Map<PlatformId, Page>;
  activePlatformId: PlatformId | null;
}

export interface RealChromeSessionView {
  platformId: PlatformId;
  context: BrowserContext;
  page: Page;
  cdpAttached: boolean;
}

let paprChromeBrowser: PaprChromeBrowser | null = null;

export function getPaprChromeBrowser(): PaprChromeBrowser | null {
  return paprChromeBrowser;
}

export function getActiveRealChromeSessionView(): RealChromeSessionView | null {
  if (!paprChromeBrowser?.activePlatformId) {
    return null;
  }
  const page = paprChromeBrowser.platformTabs.get(paprChromeBrowser.activePlatformId);
  if (!page || page.isClosed()) {
    return null;
  }
  return {
    platformId: paprChromeBrowser.activePlatformId,
    context: paprChromeBrowser.context,
    page,
    cdpAttached: paprChromeBrowser.cdpAttached,
  };
}

export function getPlatformTab(platformId: PlatformId): Page | null {
  const page = paprChromeBrowser?.platformTabs.get(platformId);
  if (!page || page.isClosed()) {
    return null;
  }
  return page;
}

export function isSharedPaprChromeProfileWarm(): boolean {
  return existsSync(getSharedPaprChromeUserDataDir());
}

export function isStalePlaywrightContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /has been closed|Target page, context or browser|Browser has been closed|Connection closed|WebSocket is not open/i.test(
    message,
  );
}

function detachPaprChromePlaywrightCache(): void {
  paprChromeBrowser = null;
}

async function isCdpContextAlive(context: BrowserContext, _cdpUrl: string): Promise<boolean> {
  try {
    const browser = context.browser();
    if (browser && !browser.isConnected()) {
      return false;
    }
    // Touch the page list — throws when Playwright lost the browser process.
    context.pages();
    return true;
  } catch {
    return false;
  }
}

async function releasePlaywrightCdpHandle(context: BrowserContext, cdpAttached: boolean): Promise<void> {
  if (!cdpAttached) {
    try {
      await context.close();
    } catch {
      /* already closed */
    }
    return;
  }
  // Never browser.close() on CDP attach — that kills Papr Chrome. Drop the Playwright handle only.
  try {
    const browser = context.browser();
    if (browser && "disconnect" in browser && typeof browser.disconnect === "function") {
      await (browser as { disconnect: () => Promise<void> }).disconnect();
    }
  } catch {
    /* websocket already gone */
  }
}

async function attachPlaywrightOverCdp(cdpUrl: string): Promise<BrowserContext> {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.connectOverCDP(cdpUrl, {
    timeout: CHROME_LAUNCH_TIMEOUT_MS,
    isLocal: true,
  });
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error(`Chrome at ${cdpUrl} has no browser context`);
  }
  console.log(`[PaprChromeSession] Attached to Google Chrome via CDP (${cdpUrl})`);
  return context;
}

async function tryConnectOverCdp(cdpUrl: string): Promise<BrowserContext | null> {
  try {
    return await attachPlaywrightOverCdp(cdpUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[PaprChromeSession] CDP attach skipped (${cdpUrl}): ${message}`);
    return null;
  }
}

async function spawnAndAttachDirectChrome(userDataDir: string): Promise<BrowserContext> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { cdpUrl } = await spawnDirectGoogleChrome({
        userDataDir,
        forceRespawn: attempt > 0,
      });
      return await attachPlaywrightOverCdp(cdpUrl);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 0 && isCdpAttachUnsupportedError(lastError)) {
        console.warn(
          "[PaprChromeSession] CDP attach failed — restarting Papr Chrome and retrying:",
          lastError.message,
        );
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("Failed to attach Playwright to Papr Chrome");
}

function reconcilePlatformTabsFromOpenPages(browser: PaprChromeBrowser): void {
  for (const page of browser.context.pages()) {
    if (page.isClosed()) {
      continue;
    }
    const platformId = findPlatformIdForUrl(page.url());
    if (!platformId) {
      continue;
    }
    const config = getPlatformConfig(platformId);
    if (!config) {
      continue;
    }
    const existing = browser.platformTabs.get(platformId);
    if (!existing || existing.isClosed()) {
      browser.platformTabs.set(platformId, page);
      continue;
    }
    const preferred = pickBestPageForPlatform([existing, page], config);
    if (preferred && preferred !== existing) {
      browser.platformTabs.set(platformId, preferred);
    }
  }
}

export async function ensurePaprChromeBrowser(): Promise<PaprChromeBrowser> {
  const userDataDir = getSharedPaprChromeUserDataDir();
  const cdpUrl = buildPlatformCdpUrl(resolvePlatformCdpPort());

  if (paprChromeBrowser) {
    const alive = await isCdpContextAlive(paprChromeBrowser.context, cdpUrl);
    if (alive) {
      reconcilePlatformTabsFromOpenPages(paprChromeBrowser);
      return paprChromeBrowser;
    }
    console.warn(
      "[PaprChromeSession] Cached Playwright CDP handle is stale — re-attaching",
    );
    await releasePlaywrightCdpHandle(
      paprChromeBrowser.context,
      paprChromeBrowser.cdpAttached,
    );
    detachPaprChromePlaywrightCache();
  }

  let context: BrowserContext | null = null;
  const cdpPort = resolvePlatformCdpPort();
  const cdpReady = await isPlatformCdpReady(cdpUrl);
  const paprProfileActive = cdpReady && isChromeUsingUserDataDir(cdpPort, userDataDir);

  if (paprProfileActive) {
    context = await tryConnectOverCdp(cdpUrl);
  } else if (cdpReady) {
    console.warn(
      `[PaprChromeSession] Port ${cdpPort} has a foreign Chrome profile (e.g. old Chrome Manager job) — respawning Papr profile`,
    );
  }

  if (!context) {
    await mkdir(userDataDir, { recursive: true });
    context = await spawnAndAttachDirectChrome(userDataDir);
  }

  paprChromeBrowser = {
    context,
    cdpAttached: true,
    platformTabs: new Map(),
    activePlatformId: null,
  };
  reconcilePlatformTabsFromOpenPages(paprChromeBrowser);
  return paprChromeBrowser;
}

function shouldNavigateTab(page: Page, config: PlatformConfig, targetUrl: string): boolean {
  if (targetUrl === "about:blank") {
    return false;
  }
  try {
    const currentUrl = page.url();
    if (currentUrl === targetUrl) {
      return false;
    }
    if (currentUrl === "about:blank") {
      return true;
    }
    const hostname = new URL(currentUrl).hostname;
    return !hostnameMatchesPlatform(hostname, config);
  } catch {
    return true;
  }
}

export async function ensurePlatformTab(
  platformId: PlatformId,
  config: PlatformConfig,
  targetUrl?: string,
): Promise<Page> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await ensurePlatformTabOnce(platformId, config, targetUrl);
    } catch (error) {
      if (attempt === 0 && isStalePlaywrightContextError(error)) {
        console.warn(
          `[PaprChromeSession] Stale CDP handle while opening ${platformId} tab — re-attaching`,
        );
        if (paprChromeBrowser) {
          await releasePlaywrightCdpHandle(
            paprChromeBrowser.context,
            paprChromeBrowser.cdpAttached,
          );
        }
        detachPaprChromePlaywrightCache();
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed to open Papr Chrome tab for ${platformId}`);
}

async function ensurePlatformTabOnce(
  platformId: PlatformId,
  config: PlatformConfig,
  targetUrl?: string,
): Promise<Page> {
  const browser = await ensurePaprChromeBrowser();

  let page = browser.platformTabs.get(platformId);
  if (page && !page.isClosed()) {
    if (targetUrl && shouldNavigateTab(page, config, targetUrl)) {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    }
    await page.bringToFront();
    browser.activePlatformId = platformId;
    return page;
  }

  const existing = pickBestPageForPlatform(browser.context.pages(), config);
  if (existing) {
    browser.platformTabs.set(platformId, existing);
    if (targetUrl && shouldNavigateTab(existing, config, targetUrl)) {
      await existing.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    }
    await existing.bringToFront();
    browser.activePlatformId = platformId;
    return existing;
  }

  page = await browser.context.newPage();
  browser.platformTabs.set(platformId, page);
  if (targetUrl) {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  }
  await page.bringToFront();
  browser.activePlatformId = platformId;
  console.log(`[PaprChromeSession] Opened new tab for ${platformId}`);
  return page;
}

export async function importCookiesForPlatform(
  context: BrowserContext,
  config: PlatformConfig,
  cookies: Cookie[],
): Promise<void> {
  if (cookies.length === 0) {
    return;
  }

  const domains = new Set<string>();
  domains.add(config.cookieDomain);
  for (const override of Object.values(config.cookieDomainOverrides ?? {})) {
    domains.add(override);
  }
  for (const extra of config.additionalDomains ?? []) {
    domains.add(extra.startsWith(".") ? extra : `.${extra}`);
  }

  for (const domain of domains) {
    await context.clearCookies({ domain });
  }
  await context.addCookies(cookies);
}

export async function disconnectPaprChromePlaywright(): Promise<void> {
  if (!paprChromeBrowser) {
    return;
  }
  const snapshot = paprChromeBrowser;
  detachPaprChromePlaywrightCache();
  await releasePlaywrightCdpHandle(snapshot.context, snapshot.cdpAttached);
}
