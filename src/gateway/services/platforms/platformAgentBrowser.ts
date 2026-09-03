/**
 * Agent browser automation using a persistent real Chrome profile (desktop).
 *
 * Spawns Papr-managed Google Chrome with one shared profile and a dedicated tab
 * per platform. Playwright attaches over CDP for automation; Python jobs use
 * port 9222 (Chrome Manager convention).
 */

import type { BrowserContext, Cookie, Page } from "playwright";
import { isCloudAgentGatewayMode } from "../../../core/utils/paprRoot.js";
import { getPlatformConfig, type PlatformConfig, type PlatformId } from "./platformRegistry.js";
import { isGoogleChromeInstalled } from "./platformChromeEnv.js";
import { getPlatformSessionService } from "./PlatformSessionService.js";
import {
  buildPlatformCdpUrl,
  resolvePlatformCdpPort,
} from "./platformDirectChromeSpawn.js";
import {
  LINKEDIN_SESSION_REJECTED_MESSAGE,
} from "./linkedinSessionValidation.js";
import { allowsPersonalChromeCookieImport } from "./platformConnectPolicy.js";
import { hasRequiredPlaywrightCookies } from "./platformCookieUtils.js";
import {
  isAuthenticatedPlatformUrl,
  platformNavigationUrlsMatch,
  shouldSkipPlatformLandingHop,
} from "./platformSessionUrl.js";
import { waitForPlaywrightPageSettle } from "./platformBrowserSettle.js";
import {
  disconnectPaprChromePlaywright,
  ensurePaprChromeBrowser,
  ensurePlatformTab,
  getActiveRealChromeSessionView,
  getPlatformTab,
  importCookiesForPlatform,
} from "./platformPaprChromeSession.js";

function resolveRealChromeCdpUrl(): string {
  if (process.env.PAPR_PLATFORM_CDP_DISABLE === "1") {
    return "";
  }
  if (process.env.LINKEDIN_CHROME_CDP_URL) {
    return process.env.LINKEDIN_CHROME_CDP_URL;
  }
  if (process.env.PAPR_PLATFORM_CDP_URL) {
    return process.env.PAPR_PLATFORM_CDP_URL;
  }
  return buildPlatformCdpUrl(resolvePlatformCdpPort());
}

const NAVIGATION_TIMEOUT_MS = 60_000;
const CONTENT_WAIT_MS = 12_000;
const MIN_BODY_HTML_LENGTH = 500;

/** CDP endpoint for real Chrome platform automation (legacy env name kept for jobs). */
export const LINKEDIN_CHROME_CDP_URL = resolveRealChromeCdpUrl();

export interface PlatformAgentBrowserPrepareResult {
  success: boolean;
  url: string;
  title: string;
  message: string;
  error?: string;
  browserMode?: "real_chrome" | "embedded";
}

interface RealChromeSession {
  platformId: PlatformId;
  context: BrowserContext;
  page: Page;
  cdpAttached: boolean;
}

/** Desktop platform connections use real Chrome when installed; embedded tab is fallback only. */
export function shouldUseRealChromeProfile(platformId: string): platformId is PlatformId {
  if (!getPlatformConfig(platformId)) {
    return false;
  }
  if (isCloudAgentGatewayMode() || process.env.PLAYWRIGHT_DOCKER === "1") {
    return false;
  }
  return isGoogleChromeInstalled();
}

export function getActiveRealChromeSession(): RealChromeSession | null {
  return getActiveRealChromeSessionView();
}

export async function closeRealChromePlatformSession(): Promise<void> {
  await disconnectPaprChromePlaywright();
}

function isRedirectLoopError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_TOO_MANY_REDIRECTS|too many redirects/i.test(message);
}

function isLoggedOutUrl(url: string): boolean {
  return (
    /\/login(?:\/|$|\?)/i.test(url) ||
    /\/signin(?:\/|$|\?)/i.test(url) ||
    /\/checkpoint(?:\/|$|\?)/i.test(url) ||
    /\/authwall/i.test(url)
  );
}

async function clearLinkedInSiteStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

async function waitForMeaningfulContent(page: Page): Promise<number> {
  try {
    await page.waitForFunction(
      `() => {
        const mainText = document.querySelector("main")?.innerText?.length ?? 0;
        const bodyText = document.body?.innerText?.length ?? 0;
        const htmlLen = document.body?.innerHTML?.length ?? 0;
        return mainText > 80 || bodyText > 120 || htmlLen > ${MIN_BODY_HTML_LENGTH};
      }`,
      { timeout: CONTENT_WAIT_MS },
    );
  } catch {
    /* fall through to length check */
  }
  return page.evaluate(`() => {
    const mainText = document.querySelector("main")?.innerText?.length ?? 0;
    const bodyText = document.body?.innerText?.length ?? 0;
    const htmlLen = document.body?.innerHTML?.length ?? 0;
    return Math.max(mainText, bodyText, htmlLen);
  }`);
}

async function navigateWithLanding(
  page: Page,
  config: PlatformConfig,
  destination: string,
): Promise<void> {
  const currentUrl = page.url();
  if (platformNavigationUrlsMatch(currentUrl, destination)) {
    return;
  }

  const landingUrl = config.prepareNavigationUrl ?? destination;
  const skipLanding = shouldSkipPlatformLandingHop(currentUrl, destination, config);

  if (skipLanding && landingUrl !== destination) {
    await page.goto(destination, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await waitForPlaywrightPageSettle(page, page.url(), {
      platformId: config.id,
    });
    return;
  }

  await page.goto(landingUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  if (
    destination !== landingUrl &&
    !platformNavigationUrlsMatch(page.url(), destination)
  ) {
    await page.goto(destination, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  }

  await waitForPlaywrightPageSettle(page, page.url(), {
    platformId: config.id,
  });
}

function isTabAuthenticatedForPlatform(page: Page, config: PlatformConfig): boolean {
  const currentUrl = page.url();
  return (
    currentUrl !== "about:blank" &&
    isAuthenticatedPlatformUrl(currentUrl, config) &&
    !isLoggedOutUrl(currentUrl)
  );
}

async function seedPlatformCookiesIfNeeded(
  page: Page,
  browser: Awaited<ReturnType<typeof ensurePaprChromeBrowser>>,
  platformId: PlatformId,
  config: PlatformConfig,
): Promise<boolean> {
  if (isTabAuthenticatedForPlatform(page, config)) {
    console.log(
      "[PlatformAgentBrowser] Reusing authenticated Papr Chrome tab — skipping cookie re-inject",
    );
    return false;
  }

  const profileCookies = await browser.context.cookies();
  if (hasRequiredPlaywrightCookies(profileCookies, config.requiredCookies)) {
    console.log(
      "[PlatformAgentBrowser] Papr Chrome profile already has session cookies — skipping keychain import",
    );
    return false;
  }

  const sessionService = getPlatformSessionService();
  let cookies = await sessionService.getSessionCookiesForBrowser(platformId);
  if (cookies.length === 0 && allowsPersonalChromeCookieImport(platformId)) {
    console.log(
      `[PlatformAgentBrowser] Importing ${config.name} session from Chrome into Papr profile`,
    );
    cookies = await sessionService.importPlaywrightCookiesFromChrome(platformId);
  } else if (cookies.length === 0) {
    console.log(
      `[PlatformAgentBrowser] No stored ${config.name} cookies — sign in via Papr-managed Chrome when connecting`,
    );
  }

  if (cookies.length > 0) {
    await importCookiesForPlatform(browser.context, config, cookies);
    return true;
  }
  return false;
}

async function rejectDeadLinkedInSession(
  platformId: PlatformId,
  context: BrowserContext,
  reason: string,
): Promise<PlatformAgentBrowserPrepareResult> {
  const sessionService = getPlatformSessionService();
  const message = LINKEDIN_SESSION_REJECTED_MESSAGE;
  await sessionService.markNeedsReauth(platformId, reason);
  const page = getPlatformTab(platformId) ?? context.pages()[0];
  return {
    success: false,
    url: page?.url() ?? "",
    title: page ? await page.title().catch(() => "") : "",
    message,
    error: `${message} (${reason})`,
  };
}

async function recoverFromRedirectLoop(
  page: Page,
  context: BrowserContext,
  platformId: PlatformId,
  config: PlatformConfig,
  destination: string,
  skipCookieReimport: boolean,
): Promise<boolean> {
  console.log("[PlatformAgentBrowser] Redirect loop detected — clearing site data and retrying navigation");
  const sessionService = getPlatformSessionService();

  if (skipCookieReimport) {
    await clearLinkedInSiteStorage(page);
    try {
      await page.goto(destination, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      await waitForPlaywrightPageSettle(page, page.url(), { platformId: config.id });
      return true;
    } catch (retryError) {
      console.warn("[PlatformAgentBrowser] Redirect recovery (authenticated tab) failed:", retryError);
      return false;
    }
  }

  let cookies = await sessionService.getSessionCookiesForBrowser(platformId);
  if (cookies.length === 0 && allowsPersonalChromeCookieImport(platformId)) {
    cookies = await sessionService.importPlaywrightCookiesFromChrome(platformId);
  }
  if (cookies.length === 0) {
    return false;
  }

  await importCookiesForPlatform(context, config, cookies);
  await clearLinkedInSiteStorage(page);

  try {
    await page.goto(destination, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await waitForPlaywrightPageSettle(page, page.url(), { platformId: config.id });
    return true;
  } catch (retryError) {
    console.warn("[PlatformAgentBrowser] Redirect recovery navigation failed:", retryError);
    return false;
  }
}

/**
 * Prepare platform automation in a persistent real Chrome profile (desktop).
 */
export async function prepareRealChromePlatformSession(
  platformId: PlatformId,
  config: PlatformConfig,
  targetUrl?: string,
): Promise<PlatformAgentBrowserPrepareResult> {
  const sessionService = getPlatformSessionService();
  const destination = targetUrl ?? config.homeUrl;

  const browser = await ensurePaprChromeBrowser();
  // Open/reuse tab without navigating — cookies must be set before first LinkedIn load.
  const page = await ensurePlatformTab(platformId, config);
  const tabAuthenticated = isTabAuthenticatedForPlatform(page, config);
  await seedPlatformCookiesIfNeeded(page, browser, platformId, config);

  try {
    await navigateWithLanding(page, config, destination);
  } catch (navigationError) {
    if (isRedirectLoopError(navigationError)) {
      const recovered = await recoverFromRedirectLoop(
        page,
        browser.context,
        platformId,
        config,
        destination,
        tabAuthenticated,
      );
      if (!recovered) {
        await sessionService.markNeedsReauth(
          platformId,
          "feed redirect loop (session rejected)",
        );
        return {
          success: false,
          url: page.url(),
          title: await page.title(),
          message: LINKEDIN_SESSION_REJECTED_MESSAGE,
          error: LINKEDIN_SESSION_REJECTED_MESSAGE,
        };
      }
    } else {
      const message = navigationError instanceof Error ? navigationError.message : String(navigationError);
      return {
        success: false,
        url: page.url(),
        title: await page.title(),
        message: `Failed to open ${config.name}.`,
        error: message,
      };
    }
  }

  const currentUrl = page.url();
  const title = await page.title();

  if (isLoggedOutUrl(currentUrl)) {
    return {
      success: false,
      url: currentUrl,
      title,
      message: `${config.name} session expired — redirected to login.`,
      error:
        `Reconnect via Settings → Platforms, then Connect to open a Chrome login window for ${config.name}.`,
    };
  }

  if (platformId !== "linkedin") {
    return {
      success: true,
      url: currentUrl,
      title,
      browserMode: "real_chrome",
      message:
        `Authenticated real Chrome window ready for ${config.name} (opens outside Papr). ` +
        `Use browser_snapshot to read the page, browser_navigate for other URLs.`,
    };
  }

  const postNavUrl = page.url();
  if (
    isAuthenticatedPlatformUrl(postNavUrl, config) &&
    !isLoggedOutUrl(postNavUrl)
  ) {
    return {
      success: true,
      url: postNavUrl,
      title: await page.title(),
      browserMode: "real_chrome",
      message:
        `Authenticated real Chrome window ready for ${config.name}. ` +
        `Use browser_snapshot to read the page, browser_navigate for other URLs.`,
    };
  }

  const bodyLength = await waitForMeaningfulContent(page);
  if (bodyLength < MIN_BODY_HTML_LENGTH && !isAuthenticatedPlatformUrl(page.url(), config)) {
    return rejectDeadLinkedInSession(
      platformId,
      browser.context,
      tabAuthenticated ? "empty page after navigation" : "empty page (sign in via Settings → Platforms if needed)",
    );
  }

  return {
    success: true,
    url: currentUrl,
    title,
    browserMode: "real_chrome",
    message:
      `Authenticated real Chrome window ready for ${config.name}. ` +
      `Use browser_snapshot to read the page, browser_navigate for other URLs.`,
  };
}

/** Open a visible Chrome window for platform login (passkeys/OAuth supported). */
export async function openRealChromeLoginWindow(
  platformId: PlatformId,
  loginUrl: string,
): Promise<void> {
  await openRealChromePlatformWindow(platformId, loginUrl);
}

/**
 * Open Papr-managed Chrome to a URL in this platform's tab (does not reuse other platforms' tabs).
 */
export async function openRealChromePlatformWindow(
  platformId: PlatformId,
  url: string,
  seedCookies?: Cookie[],
): Promise<void> {
  const config = getPlatformConfig(platformId);
  if (!config) {
    throw new Error(`Unknown platform: ${platformId}`);
  }

  const browser = await ensurePaprChromeBrowser();
  const page = await ensurePlatformTab(platformId, config);

  if (seedCookies && seedCookies.length > 0) {
    await importCookiesForPlatform(browser.context, config, seedCookies);
  }

  if (!platformNavigationUrlsMatch(page.url(), url)) {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  }

  console.log(
    `[PlatformAgentBrowser] Opened ${url} in Papr-managed Chrome tab for ${platformId}`,
  );
}

interface CdpNetworkCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

function mapCdpCookieToPlaywright(cookie: CdpNetworkCookie): Cookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite ?? "Lax",
  };
}

async function readCookiesViaCdp(page: Page): Promise<Cookie[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const response = (await cdp.send("Network.getAllCookies")) as {
      cookies: CdpNetworkCookie[];
    };
    return response.cookies.map(mapCdpCookieToPlaywright);
  } finally {
    await cdp.detach();
  }
}

export function getRealChromeSessionUrl(platformId: PlatformId): string | null {
  const page = getPlatformTab(platformId);
  if (!page) {
    return null;
  }
  try {
    return page.url();
  } catch {
    return null;
  }
}

export async function getRealChromeSessionCookies(platformId: PlatformId): Promise<Cookie[]> {
  const page = getPlatformTab(platformId);
  if (!page) {
    return [];
  }
  try {
    return await readCookiesViaCdp(page);
  } catch (error) {
    console.warn(
      `[PlatformAgentBrowser] Could not read cookies from real Chrome session for ${platformId}:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

export function buildRequiredCookieValuesFromPlaywright(
  config: PlatformConfig,
  cookies: Cookie[],
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of config.requiredCookies) {
    const cookie = cookies.find((entry) => entry.name === name);
    if (cookie?.value) {
      values[name] = cookie.value;
    } else {
      missing.push(name);
    }
  }
  return { values, missing };
}

/** Ensure real Chrome is running with CDP for Python/Node job attachment. */
export async function ensureRealChromeCdp(platformId: PlatformId): Promise<string> {
  const cdpUrl = LINKEDIN_CHROME_CDP_URL;
  if (!cdpUrl) {
    throw new Error(
      "Platform CDP is disabled (PAPR_PLATFORM_CDP_DISABLE=1). Real Chrome jobs require CDP on port 9222.",
    );
  }
  const config = getPlatformConfig(platformId);
  if (!config) {
    throw new Error(`Unknown platform: ${platformId}`);
  }
  await ensurePaprChromeBrowser();
  await ensurePlatformTab(platformId, config);
  return cdpUrl;
}
