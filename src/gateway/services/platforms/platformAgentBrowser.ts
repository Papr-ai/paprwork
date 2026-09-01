/**
 * Agent browser automation using a persistent real Chrome profile (desktop LinkedIn).
 *
 * LinkedIn rejects headless Chromium with injected cookies. This path launches
 * Google Chrome via Playwright's channel + launchPersistentContext so the agent
 * reuses an on-disk profile and can import cookies from the user's Chrome login.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { BrowserContext, Cookie, Page } from "playwright";
import { isCloudAgentGatewayMode } from "../../../core/utils/paprRoot.js";
import { isGoogleChromeInstalled } from "./platformChromeEnv.js";
import type { PlatformConfig, PlatformId } from "./platformRegistry.js";
import { getPlatformSessionService } from "./PlatformSessionService.js";

const NAVIGATION_TIMEOUT_MS = 60_000;
const CONTENT_WAIT_MS = 12_000;
const MIN_BODY_HTML_LENGTH = 500;
const CHROME_LAUNCH_TIMEOUT_MS = 30_000;

export interface PlatformAgentBrowserPrepareResult {
  success: boolean;
  url: string;
  title: string;
  message: string;
  error?: string;
}

interface RealChromeSession {
  platformId: PlatformId;
  context: BrowserContext;
  page: Page;
}

let activeRealChromeSession: RealChromeSession | null = null;

/** Desktop LinkedIn uses real Chrome profile; cloud and other platforms stay on headless inject. */
export function shouldUseRealChromeProfile(platformId: string): platformId is PlatformId {
  if (platformId !== "linkedin") {
    return false;
  }
  if (isCloudAgentGatewayMode() || process.env.PLAYWRIGHT_DOCKER === "1") {
    return false;
  }
  return isGoogleChromeInstalled();
}

export function getActiveRealChromeSession(): RealChromeSession | null {
  return activeRealChromeSession;
}

export async function closeRealChromePlatformSession(): Promise<void> {
  if (!activeRealChromeSession) {
    return;
  }
  try {
    await activeRealChromeSession.context.close();
  } catch (error) {
    console.warn("[PlatformAgentBrowser] Error closing real Chrome session:", error);
  }
  activeRealChromeSession = null;
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
      `() => (document.body?.innerHTML?.length ?? 0) > ${MIN_BODY_HTML_LENGTH}`,
      { timeout: CONTENT_WAIT_MS },
    );
  } catch {
    /* fall through to length check */
  }
  return page.evaluate("() => document.body?.innerHTML?.length ?? 0");
}

async function navigateWithLanding(
  page: Page,
  config: PlatformConfig,
  destination: string,
): Promise<void> {
  const landingUrl = config.prepareNavigationUrl ?? destination;
  await page.goto(landingUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  if (destination !== landingUrl) {
    await page.goto(destination, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  }
}

async function importCookiesIntoContext(
  context: BrowserContext,
  cookies: Cookie[],
): Promise<void> {
  if (cookies.length === 0) {
    return;
  }
  await context.clearCookies();
  await context.addCookies(cookies);
}

async function launchRealChromeContext(
  platformId: PlatformId,
  userDataDir: string,
): Promise<BrowserContext> {
  await mkdir(userDataDir, { recursive: true });
  const playwright = await import("playwright");

  const context = await Promise.race([
    playwright.chromium.launchPersistentContext(userDataDir, {
      headless: true,
      channel: "chrome",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Chrome launch timed out after ${CHROME_LAUNCH_TIMEOUT_MS / 1000}s`)),
        CHROME_LAUNCH_TIMEOUT_MS,
      );
    }),
  ]);

  console.log(
    `[PlatformAgentBrowser] Launched real Chrome persistent profile for ${platformId} at ${userDataDir}`,
  );
  return context;
}

async function ensureRealChromeSession(
  platformId: PlatformId,
  userDataDir: string,
): Promise<RealChromeSession> {
  if (activeRealChromeSession?.platformId === platformId) {
    const existingPages = activeRealChromeSession.context.pages();
    if (existingPages.length > 0) {
      return {
        platformId,
        context: activeRealChromeSession.context,
        page: activeRealChromeSession.page,
      };
    }
  }

  await closeRealChromePlatformSession();
  const context = await launchRealChromeContext(platformId, userDataDir);
  const page = context.pages()[0] ?? (await context.newPage());
  activeRealChromeSession = { platformId, context, page };
  return activeRealChromeSession;
}

async function recoverFromRedirectLoop(
  session: RealChromeSession,
  platformId: PlatformId,
  config: PlatformConfig,
  destination: string,
): Promise<boolean> {
  console.log("[PlatformAgentBrowser] Redirect loop detected — clearing site data and re-importing from Chrome");
  const sessionService = getPlatformSessionService();
  const cookies = await sessionService.importPlaywrightCookiesFromChrome(platformId);
  if (cookies.length === 0) {
    return false;
  }

  await importCookiesIntoContext(session.context, cookies);
  await clearLinkedInSiteStorage(session.page);

  try {
    await navigateWithLanding(session.page, config, destination);
    return true;
  } catch (retryError) {
    console.warn("[PlatformAgentBrowser] Redirect recovery navigation failed:", retryError);
    return false;
  }
}

/**
 * Prepare LinkedIn automation in a persistent real Chrome profile (desktop only).
 */
export async function prepareRealChromePlatformSession(
  platformId: PlatformId,
  config: PlatformConfig,
  targetUrl?: string,
): Promise<PlatformAgentBrowserPrepareResult> {
  const sessionService = getPlatformSessionService();
  const userDataDir = sessionService.getBrowserDataDir(platformId);
  const profileExists = existsSync(userDataDir);

  let session = await ensureRealChromeSession(platformId, userDataDir);
  const destination = targetUrl ?? config.homeUrl;

  let cookies = await sessionService.getSessionCookiesForBrowser(platformId);
  if (!profileExists || cookies.length === 0) {
    console.log("[PlatformAgentBrowser] Importing LinkedIn session from Chrome into agent profile");
    cookies = await sessionService.importPlaywrightCookiesFromChrome(platformId);
  }

  if (cookies.length > 0) {
    await importCookiesIntoContext(session.context, cookies);
  }

  try {
    await navigateWithLanding(session.page, config, destination);
  } catch (navigationError) {
    if (isRedirectLoopError(navigationError)) {
      const recovered = await recoverFromRedirectLoop(session, platformId, config, destination);
      if (!recovered) {
        return {
          success: false,
          url: session.page.url(),
          title: await session.page.title(),
          message: `${config.name} session blocked by redirect loop.`,
          error:
            "LinkedIn rejected the session (ERR_TOO_MANY_REDIRECTS). Disconnect and reconnect via Settings → Platforms, ensuring you are logged into LinkedIn in Chrome.",
        };
      }
    } else {
      const message = navigationError instanceof Error ? navigationError.message : String(navigationError);
      return {
        success: false,
        url: session.page.url(),
        title: await session.page.title(),
        message: `Failed to open ${config.name}.`,
        error: message,
      };
    }
  }

  const currentUrl = session.page.url();
  const title = await session.page.title();

  if (isLoggedOutUrl(currentUrl)) {
    return {
      success: false,
      url: currentUrl,
      title,
      message: `${config.name} session expired — redirected to login.`,
      error:
        "Reconnect via Settings → Platforms. On desktop, log into LinkedIn in Google Chrome first, then Connect.",
    };
  }

  const bodyLength = await waitForMeaningfulContent(session.page);
  if (bodyLength < MIN_BODY_HTML_LENGTH) {
    const reimported = await sessionService.importPlaywrightCookiesFromChrome(platformId);
    if (reimported.length > 0) {
      await importCookiesIntoContext(session.context, reimported);
      await clearLinkedInSiteStorage(session.page);
      try {
        await navigateWithLanding(session.page, config, destination);
      } catch (retryError) {
        if (isRedirectLoopError(retryError)) {
          await recoverFromRedirectLoop(session, platformId, config, destination);
        }
      }
      const retryLength = await waitForMeaningfulContent(session.page);
      if (retryLength >= MIN_BODY_HTML_LENGTH && !isLoggedOutUrl(session.page.url())) {
        return {
          success: true,
          url: session.page.url(),
          title: await session.page.title(),
          message:
            `Authenticated real Chrome profile ready for ${config.name}. ` +
            `Use browser_snapshot to read the page, browser_navigate for other URLs.`,
        };
      }
    }

    return {
      success: false,
      url: session.page.url(),
      title: await session.page.title(),
      message: `${config.name} page loaded but content is empty — session likely invalid.`,
      error:
        "LinkedIn returned an empty page in the automation browser. Disconnect and reconnect via Settings → Platforms after logging into LinkedIn in Chrome.",
    };
  }

  return {
    success: true,
    url: currentUrl,
    title,
    message:
      `Authenticated real Chrome profile ready for ${config.name}. ` +
      `Use browser_snapshot to read the page, browser_navigate for other URLs.`,
  };
}
