import { installPlaywrightChromium } from "../utils/installPlaywrightChromium.js";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Browser, BrowserContext, Page } from "playwright";
import { isCloudAgentGatewayMode } from "../utils/paprRoot.js";
import { getApiKeysForSanitization, sanitizeToolOutput } from "./security.js";
import { wrapUntrustedContent } from "./contentProvenance.js";
import { getBrowserToolWebviewBlockReason } from "./webviewSessionGuard.js";
import { detectManualAuthCheckpoint } from "../utils/platformBrowserBashGuard.js";
import {
  EXTRACT_PAGE_SCRIPT,
  buildSections,
  formatElements,
  formatRanking,
  formatSections,
  rankAgainstGoal,
  refSelector,
  type RawExtraction,
} from "./pageExtract.js";
import { runGoto, type GotoPage } from "./browserGoto.js";
import { recordBrowseAction } from "./browseNudge.js";

import { EmbeddedBrowserPageAdapter } from "../../gateway/services/platforms/embeddedBrowserPageAdapter.js";

type BrowserPage = Page | EmbeddedBrowserPageAdapter;

interface BrowserSessionState {
  page: BrowserPage;
  consoleLogs: BrowserConsoleLog[];
  networkLogs: BrowserNetworkLog[];
  browser?: Browser;
  persistentContext?: BrowserContext;
  platformId?: string;
  embeddedPlatformId?: string;
}

function isPlaywrightPage(page: BrowserPage): page is Page {
  return !(page instanceof EmbeddedBrowserPageAdapter);
}

function requirePlaywrightPage(session: BrowserSessionState): Page {
  if (session.embeddedPlatformId || !isPlaywrightPage(session.page)) {
    throw new Error(
      "This browser action requires the Playwright session. On desktop, use browser_snapshot, browser_navigate, browser_click, or browser_type with the real Chrome window opened by prepare_browser.",
    );
  }
  return session.page;
}

// Track if we've already tried installing Playwright browsers

export interface BrowserConsoleLog {
  type: string;
  text: string;
  location: string;
  timestamp: string;
}

export interface BrowserNetworkLog {
  url: string;
  method: string;
  status: number;
  ok: boolean;
  resourceType: string;
  timestamp: string;
}

let browserSession: BrowserSessionState | null = null;

function attachPageListeners(
  page: Page,
  consoleLogs: BrowserConsoleLog[],
  networkLogs: BrowserNetworkLog[],
): void {
  page.on("console", (msg) => {
    consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location().url || "",
      timestamp: new Date().toISOString(),
    });
    if (consoleLogs.length > 500) {
      consoleLogs.shift();
    }
  });

  page.on("response", (response) => {
    const request = response.request();
    networkLogs.push({
      url: response.url(),
      method: request.method(),
      status: response.status(),
      ok: response.ok(),
      resourceType: request.resourceType(),
      timestamp: new Date().toISOString(),
    });
    if (networkLogs.length > 500) {
      networkLogs.shift();
    }
  });
}

async function closeActiveBrowserSession(): Promise<void> {
  if (!browserSession) {
    return;
  }
  try {
    if (browserSession.embeddedPlatformId) {
      const { clearEmbeddedPlatformSession } = await import(
        "../../gateway/services/platforms/embeddedBrowserPageAdapter.js"
      );
      clearEmbeddedPlatformSession();
    } else if (browserSession.persistentContext) {
      // Papr Chrome keeps running with per-platform tabs — only clear tool binding.
    } else if (browserSession.browser) {
      await browserSession.browser.close();
    }
  } catch (error) {
    console.warn("[Browser Tool] Error closing browser session:", error);
  }
  browserSession = null;
  chatSessions.clear();
  basePageClaimedBy = null;
}

function bindRealChromeSession(
  platformId: string,
  context: BrowserContext,
  page: Page,
): BrowserSessionState {
  const consoleLogs: BrowserConsoleLog[] = [];
  const networkLogs: BrowserNetworkLog[] = [];
  attachPageListeners(page, consoleLogs, networkLogs);
  return {
    page,
    consoleLogs,
    networkLogs,
    persistentContext: context,
    platformId,
  };
}

export function realChromeUserAgent(version: string, platform: string = process.platform): string {
  const os =
    platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  const v = /^\d+/.test(version) ? version : "130.0.0.0";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
}

/** Cap wait timeouts — LLM args skip Zod parse; timeout:0 hangs forever in Playwright */
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 30_000;
const CHROMIUM_LAUNCH_MS = 20_000;

function resolveWaitTimeoutMs(raw: number | undefined): number {
  if (raw === undefined || Number.isNaN(raw) || raw <= 0) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(raw, MAX_WAIT_MS);
}

function resolveFixedDelaySeconds(raw: number | undefined): number {
  if (raw === undefined || Number.isNaN(raw) || raw <= 0) {
    return 1;
  }
  return Math.min(raw, 30);
}

async function requestBrowserPermission(action: string): Promise<void> {
  try {
    const { requestKeyPermission } =
      await import("../../gateway/permissions/PermissionRequester.js");
    const response = await requestKeyPermission({
      keyName: "BROWSER_TOOL",
      description: `Allow browser automation action: ${action}?`,
      isEnvKey: false,
      toolContext: {
        toolName: "browser",
        command: action,
      },
    });
    if (!response.approved) {
      throw new Error("Browser permission denied by user");
    }
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "Browser permission request failed",
    );
  }
}

function isPlatformBrowserToolSessionActive(): boolean {
  return (
    browserSession !== null &&
    (browserSession.platformId !== undefined ||
      browserSession.embeddedPlatformId !== undefined)
  );
}

async function assertBrowserToolAllowed(toolName: string): Promise<void> {
  const reason = await getBrowserToolWebviewBlockReason(toolName, {
    platformBrowserActive: isPlatformBrowserToolSessionActive(),
  });
  if (reason) {
    throw new Error(reason);
  }
}

async function fetchEmbeddedPlatformLogs(
  platformId: string,
  kind: "get_console_logs" | "get_network_logs",
  limit: number,
  clearAfterRead?: boolean,
): Promise<{ count: number; logs: BrowserConsoleLog[] | BrowserNetworkLog[] }> {
  const { requestPlatformBrowser } = await import(
    "../../gateway/utils/platformBrowserBridge.js"
  );
  const response = await requestPlatformBrowser({
    action: kind,
    payload: { platformId, limit, clearAfterRead: clearAfterRead ?? false },
  });
  if (!response.success) {
    throw new Error(response.error ?? `Failed to read platform browser ${kind}`);
  }
  const data = response.data as {
    count?: number;
    logs?: BrowserConsoleLog[] | BrowserNetworkLog[];
  };
  return {
    count: data.count ?? data.logs?.length ?? 0,
    logs: data.logs ?? [],
  };
}

/**
 * Check if an error indicates Playwright package or browser is missing
 */
function isPlaywrightMissingError(errorMessage: string): boolean {
  return (
    errorMessage.includes("Cannot find package") ||
    errorMessage.includes("Cannot find module") ||
    errorMessage.includes("Executable doesn't exist") ||
    errorMessage.includes("browserType.launch") ||
    errorMessage.includes("not found") ||
    errorMessage.includes("PLAYWRIGHT") ||
    errorMessage.includes("ENOENT") ||
    errorMessage.includes("timed out")
  );
}

const PLATFORM_NAVIGATION_TIMEOUT_MS = 60_000;

export interface PlatformBrowserPrepareResult {
  success: boolean;
  url: string;
  title: string;
  message: string;
  error?: string;
  browserMode?: "real_chrome" | "embedded";
}

/**
 * Prepare a connected platform session for agent browser automation.
 * Desktop uses a persistent real Chrome window when Google Chrome is installed.
 */
export async function preparePlatformBrowserSession(
  platformId: string,
  targetUrl?: string,
): Promise<PlatformBrowserPrepareResult> {
  const { shouldUseRealChromeProfile, prepareRealChromePlatformSession } = await import(
    "../../gateway/services/platforms/platformAgentBrowser.js"
  );
  const { getPlatformSessionService } = await import(
    "../../gateway/services/platforms/PlatformSessionService.js"
  );
  const { getPlatformConfig } = await import(
    "../../gateway/services/platforms/platformRegistry.js"
  );
  type PlatformId = import("../../gateway/services/platforms/platformRegistry.js").PlatformId;

  const sessionService = getPlatformSessionService();
  await sessionService.initialize();

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

  const status = await sessionService.getStatus(platformId as PlatformId);
  if (status.status !== "connected") {
    return {
      success: false,
      url: "",
      title: "",
      message: `${config.name} is not connected.`,
      error: `Status: ${status.status}. Use connect_platform request_connect or Settings → Platform Connections.`,
    };
  }

  if (shouldUseRealChromeProfile(platformId)) {
    await closeActiveBrowserSession();
    const result = await prepareRealChromePlatformSession(
      platformId as PlatformId,
      config,
      targetUrl,
    );
    if (result.success) {
      const { getActiveRealChromeSession } = await import(
        "../../gateway/services/platforms/platformAgentBrowser.js"
      );
      const realSession = getActiveRealChromeSession();
      if (realSession) {
        browserSession = bindRealChromeSession(
          platformId,
          realSession.context,
          realSession.page,
        );
      }
    }
    return result;
  }

  const { shouldUseEmbeddedPlatformBrowser, prepareEmbeddedPlatformSession } =
    await import("../../gateway/services/platforms/platformEmbeddedBrowser.js");

  if (shouldUseEmbeddedPlatformBrowser(platformId)) {
    await closeActiveBrowserSession();
    const result = await prepareEmbeddedPlatformSession(
      platformId as PlatformId,
      targetUrl,
    );
    if (result.success) {
      const { bindEmbeddedPlatformSession } = await import(
        "../../gateway/services/platforms/embeddedBrowserPageAdapter.js"
      );
      browserSession = {
        page: bindEmbeddedPlatformSession(platformId as PlatformId),
        consoleLogs: [],
        networkLogs: [],
        platformId,
        embeddedPlatformId: platformId,
      };
    }
    return { ...result, browserMode: "embedded" };
  }

  const cookies = await sessionService.getSessionCookiesForBrowser(platformId as PlatformId);
  if (cookies.length === 0) {
    return {
      success: false,
      url: "",
      title: "",
      message: `No session cookies found for ${config.name}.`,
      error: "Reconnect via Settings → Platform Connections.",
    };
  }

  await closeActiveBrowserSession();
  const session = await getBrowserSession();
  if (session.embeddedPlatformId) {
    throw new Error("Headless cookie injection is not used for embedded platform sessions");
  }
  const page = requirePlaywrightPage(session);
  const context = page.context();
  await context.clearCookies();
  await context.addCookies(cookies);

  const destination = targetUrl ?? config.homeUrl;
  const landingUrl = config.prepareNavigationUrl ?? destination;

  await page.goto(landingUrl, {
    waitUntil: "domcontentloaded",
    timeout: PLATFORM_NAVIGATION_TIMEOUT_MS,
  });

  if (destination !== landingUrl) {
    await page.goto(destination, {
      waitUntil: "domcontentloaded",
      timeout: PLATFORM_NAVIGATION_TIMEOUT_MS,
    });
  }

  const { waitForPlaywrightPageSettle } = await import(
    "../../gateway/services/platforms/platformBrowserSettle.js"
  );
  await waitForPlaywrightPageSettle(page, page.url(), { platformId });

  const currentUrl = page.url();
  const title = await page.title();

  const authenticated = config.successUrlPattern.test(currentUrl);
  const loggedOut =
    !authenticated &&
    (/\/login(?:\/|$|\?)/i.test(currentUrl) ||
      /\/signin(?:\/|$|\?)/i.test(currentUrl) ||
      /\/checkpoint(?:\/|$|\?)/i.test(currentUrl));

  if (loggedOut) {
    const cookieDomains = cookies.map((c) => `${c.name}@${c.domain}`).join(", ");
    if (platformId === "linkedin") {
      await sessionService.markNeedsReauth(
        platformId as PlatformId,
        "redirected to login",
      );
    }
    return {
      success: false,
      url: currentUrl,
      title,
      message:
        platformId === "linkedin"
          ? "LinkedIn rejected the saved session. Reconnect LinkedIn in Settings → Platforms, then run again."
          : `${config.name} session expired — redirected to login.`,
      error:
        platformId === "linkedin"
          ? "LinkedIn rejected the saved session. Reconnect LinkedIn in Settings → Platforms, then run again."
          : `Reconnect via Settings → Platform Connections, or try connect_platform action="refresh" then prepare_browser again. ` +
            `Injected cookies: ${cookieDomains}. Do NOT fall back to Voyager/GraphQL API calls.`,
    };
  }

  return {
    success: true,
    url: currentUrl,
    title,
    message:
      `Authenticated browser ready for ${config.name}. ` +
      `Use browser_snapshot to read the page, browser_navigate for other URLs.`,
  };
}

/**
 * Per-chat pages for the plain headless browser, so parallel agent chats don't drive the same tab.
 * The first chat reuses the base page; later chats get their own page in the same context.
 * Platform sessions (Papr Chrome / embedded tab) are one logged-in tab and stay shared.
 */
const chatSessions = new Map<string, BrowserSessionState>();
let basePageClaimedBy: string | null = null;
const MAX_CHAT_PAGES = 8;

async function getBrowserSession(): Promise<BrowserSessionState> {
  const base = await getBaseBrowserSession();
  if (!base.browser || base.platformId || base.embeddedPlatformId) {
    return base;
  }
  const { getCurrentChatId } = await import("./context.js");
  const chatId = getCurrentChatId();
  if (!chatId) {
    return base;
  }
  const existing = chatSessions.get(chatId);
  if (existing && !requirePlaywrightPage(existing).isClosed()) {
    return existing;
  }
  if (!basePageClaimedBy || basePageClaimedBy === chatId) {
    basePageClaimedBy = chatId;
    chatSessions.set(chatId, base);
    return base;
  }
  const page = await requirePlaywrightPage(base).context().newPage();
  const consoleLogs: BrowserConsoleLog[] = [];
  const networkLogs: BrowserNetworkLog[] = [];
  attachPageListeners(page, consoleLogs, networkLogs);
  const session: BrowserSessionState = { browser: base.browser, page, consoleLogs, networkLogs };
  chatSessions.set(chatId, session);
  if (chatSessions.size > MAX_CHAT_PAGES) {
    for (const [id, s2] of chatSessions) {
      if (s2 === base || id === chatId) continue;
      chatSessions.delete(id);
      await requirePlaywrightPage(s2).close().catch(() => {});
      break;
    }
  }
  return session;
}

/** Close only this chat's own page (never the shared base page). Returns true if one was closed. */
async function closeChatPage(): Promise<boolean> {
  const { getCurrentChatId } = await import("./context.js");
  const chatId = getCurrentChatId();
  const own = chatId ? chatSessions.get(chatId) : undefined;
  if (!chatId || !own || own === browserSession) return false;
  chatSessions.delete(chatId);
  await requirePlaywrightPage(own).close().catch(() => {});
  return true;
}

/** Serialize long multi-navigation work (browser_goto) on one page — parallel calls in a chat collide. */
const pageLocks = new WeakMap<object, Promise<unknown>>();
async function withPageLock<T>(page: object, fn: () => Promise<T>): Promise<T> {
  const prev = pageLocks.get(page) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  pageLocks.set(page, prev.then(() => mine));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function getBaseBrowserSession(): Promise<BrowserSessionState> {
  if (browserSession) {
    return browserSession;
  }

  const { getActiveEmbeddedPlatformId } = await import(
    "../../gateway/services/platforms/embeddedBrowserPageAdapter.js"
  );
  const embeddedPlatformId = getActiveEmbeddedPlatformId();
  if (embeddedPlatformId) {
    const { bindEmbeddedPlatformSession } = await import(
      "../../gateway/services/platforms/embeddedBrowserPageAdapter.js"
    );
    browserSession = {
      page: bindEmbeddedPlatformSession(embeddedPlatformId),
      consoleLogs: [],
      networkLogs: [],
      platformId: embeddedPlatformId,
      embeddedPlatformId,
    };
    return browserSession;
  }

  const { getActiveRealChromeSession } = await import(
    "../../gateway/services/platforms/platformAgentBrowser.js"
  );
  const realSession = getActiveRealChromeSession();
  if (realSession) {
    browserSession = bindRealChromeSession(
      realSession.platformId,
      realSession.context,
      realSession.page,
    );
    return browserSession;
  }

  // Wrap entire import + launch in try-catch for auto-install
  let module: typeof import("playwright");
  let browser: Browser;

  try {
    module = await import("playwright");
  } catch (importError) {
    const errorMessage =
      importError instanceof Error ? importError.message : String(importError);

    if (isPlaywrightMissingError(errorMessage)) {
      console.log("[Browser Tool] Playwright not found, installing Chromium...");
      console.log("[Browser Tool] Error was:", errorMessage);

      try {
        await installPlaywrightChromium();
        console.log("[Browser Tool] Chromium installed successfully");
        module = await import("playwright");
      } catch (installError) {
        console.error("[Browser Tool] Failed to install Playwright:", installError);
        throw new Error(
          "Playwright browser not installed. Please run: npx playwright install chromium",
        );
      }
    } else {
      throw importError;
    }
  }

  const launchOptions: Parameters<typeof module.chromium.launch>[0] = {
    headless: true,
    // Some sites (e.g. a16z) serve a stripped page when navigator.webdriver is true.
    args: ["--disable-blink-features=AutomationControlled"],
  };
  if (isCloudAgentGatewayMode() || process.env.PLAYWRIGHT_DOCKER === "1") {
    launchOptions.args = [
      ...(launchOptions.args ?? []),
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ];
  }

  // Try to launch, auto-install on failure
  try {
    browser = await Promise.race([
      module.chromium.launch(launchOptions),
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `Chromium launch timed out after ${CHROMIUM_LAUNCH_MS / 1000}s`,
              ),
            ),
          CHROMIUM_LAUNCH_MS,
        );
      }),
    ]);
  } catch (launchError) {
    const errorMessage =
      launchError instanceof Error ? launchError.message : String(launchError);

    // Check if it's a browser not found error and we haven't tried installing yet
    if (isPlaywrightMissingError(errorMessage)) {
      console.log(
        "[Browser Tool] Playwright browsers not found, installing Chromium...",
      );

      try {
        // Install only Chromium (faster than all browsers)
        await installPlaywrightChromium();
        console.log("[Browser Tool] Chromium installed successfully");

        // Retry launch
        browser = await module.chromium.launch(launchOptions);
      } catch (installError) {
        console.error("[Browser Tool] Failed to install Playwright:", installError);
        throw new Error(
          "Playwright browser not installed. Please run: npx playwright install chromium",
        );
      }
    } else {
      throw launchError;
    }
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    // Headless Chromium advertises "HeadlessChrome"; bot-shy sites then serve empty pages.
    userAgent: realChromeUserAgent(browser.version()),
  });
  const page = await context.newPage();
  const consoleLogs: BrowserConsoleLog[] = [];
  const networkLogs: BrowserNetworkLog[] = [];
  attachPageListeners(page, consoleLogs, networkLogs);

  browserSession = { browser, page, consoleLogs, networkLogs };
  return browserSession;
}

const navigateSchema = z.object({
  url: z.string().url(),
});

const snapshotSchema = z.object({
  goal: z
    .string()
    .min(3)
    .optional()
    .describe(
      "What you are looking for on this page (e.g. 'Business plan price', 'link to API rate limits'). " +
        "Returns only the most relevant sections and elements, ranked by Jev. Omit to get the whole page.",
    ),
  format: z
    .enum(["text", "html"])
    .optional()
    .describe("text (default): readable sections + numbered elements. html: raw HTML (debugging selectors only)."),
  maxChars: z.number().int().min(200).max(100000).optional(),
});

const clickSchema = z
  .object({
    ref: z.number().int().min(0).optional().describe("Element number [N] from browser_snapshot"),
    selector: z.string().min(1).optional().describe("CSS selector (use ref when you have one)"),
  });

const typeSchema = z
  .object({
    ref: z.number().int().min(0).optional().describe("Element number [N] from browser_snapshot"),
    selector: z.string().min(1).optional().describe("CSS selector (use ref when you have one)"),
    text: z.string(),
  });

function targetSelector(args: { ref?: number; selector?: string }): string {
  if (args.ref !== undefined) return refSelector(args.ref);
  if (args.selector) return args.selector;
  throw new Error("Pass ref (the [N] number from browser_snapshot) or selector.");
}

const tabsSchema = z.object({
  action: z.enum(["list", "close"]),
});

const browserLogsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  clearAfterRead: z.boolean().optional(),
});

const browserScriptSchema = z.object({
  script: z.string().min(1),
});

const fillFormSchema = z.object({
  fields: z
    .array(
      z.object({
        selector: z.string().describe("CSS selector for form field"),
        value: z.string().describe("Value to fill"),
        clear: z
          .boolean()
          .optional()
          .default(true)
          .describe("Clear before filling"),
      }),
    )
    .min(1)
    .describe("Array of form fields to fill"),
});

const scrollSchema = z.object({
  selector: z.string().optional().describe("Element to scroll into view"),
  direction: z
    .enum(["up", "down", "left", "right"])
    .optional()
    .describe("Scroll direction"),
  amount: z
    .number()
    .optional()
    .default(300)
    .describe("Pixels to scroll (used with direction)"),
  deltaX: z
    .number()
    .optional()
    .describe("Horizontal scroll (positive = right, negative = left)"),
  deltaY: z
    .number()
    .optional()
    .describe("Vertical scroll (positive = down, negative = up)"),
});

function sanitizeBrowserData(data: unknown): unknown {
  const apiKeys = getApiKeysForSanitization();
  const sanitized = sanitizeToolOutput(data, apiKeys);
  // No truncation - prepareStep keeps last tool result full
  return sanitized;
}

export const browserNavigateTool = createTool({
  id: "browser_navigate",
  description:
    "Navigate the browser session to a URL. Automatically waits for the page to settle after navigation (platform-aware pacing for LinkedIn/social — ~4s on LinkedIn). For LinkedIn/social/custom sites: call connect_platform prepare_browser FIRST (Papr Chrome on desktop; headless Playwright with keychain cookies otherwise). Then navigate/snapshot/click.",
  inputSchema: navigateSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof navigateSchema> }).context ?? input;
    await assertBrowserToolAllowed("browser_navigate");
    await requestBrowserPermission(`navigate:${args.url}`);
    const session = await getBrowserSession();
    await session.page.goto(args.url, { waitUntil: "domcontentloaded" });
    const url = session.page.url();
    const title = await session.page.title();

    let settleWaitMs = 0;
    let contentReady = false;
    if (isPlaywrightPage(session.page)) {
      const { waitForPlaywrightPageSettle } = await import(
        "../../gateway/services/platforms/platformBrowserSettle.js"
      );
      const settle = await waitForPlaywrightPageSettle(session.page, url, {
        platformId: session.platformId,
      });
      settleWaitMs = settle.waitedMs;
      contentReady = settle.contentReady;
    } else {
      const { sleepForNavigationSettle } = await import(
        "../../gateway/services/platforms/platformBrowserSettle.js"
      );
      const settle = await sleepForNavigationSettle(url, session.platformId);
      settleWaitMs = settle.waitedMs;
    }

    const ctx = `url: ${url}`;
    return sanitizeBrowserData({
      success: true,
      data: {
        url: wrapUntrustedContent("browser", ctx, url),
        title: wrapUntrustedContent("browser", ctx, title),
        settleWaitMs,
        contentReady,
        ...(contentReady
          ? {}
          : {
              note:
                "Page may still be rendering. Wait with page_wait_for({ target: 'browser', time: 2 }) before browser_test_script if scripts fail.",
            }),
      },
    }) as {
      success: boolean;
      data: {
        url: string;
        title: string;
        settleWaitMs: number;
        contentReady: boolean;
        note?: string;
      };
    };
  },
});

async function extractPage(page: BrowserPage): Promise<RawExtraction | null> {
  try {
    const raw = (await page.evaluate(EXTRACT_PAGE_SCRIPT)) as RawExtraction | undefined;
    if (!raw || !Array.isArray(raw.blocks) || !Array.isArray(raw.elements)) return null;
    return raw;
  } catch {
    return null;
  }
}

export const browserSnapshotTool = createTool({
  id: "browser_snapshot",
  description:
    "How the agent SEES the page. Returns readable text grouped under page headings plus a numbered list of " +
    "links/buttons/inputs — act on them with browser_click({ ref }) / browser_type({ ref, text }). " +
    "Pass goal (e.g. 'Enterprise plan price', 'link to rate limit docs') to get only the most relevant sections " +
    "and elements, ranked by Jev — much cheaper on long pages. format: 'html' returns raw HTML (debugging only). " +
    "Primary vision tool — not screenshots.",
  inputSchema: snapshotSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof snapshotSchema> }).context ?? input;
    await assertBrowserToolAllowed("browser_snapshot");
    await requestBrowserPermission("snapshot");
    const session = await getBrowserSession();
    const url = session.page.url();
    const title = await session.page.title();
    const ctx = `url: ${url}`;
    const wrap = (v: string) => wrapUntrustedContent("browser", ctx, v);

    const raw = args.format === "html" ? null : await extractPage(session.page);
    if (!raw) {
      const html = await session.page.content();
      const maxChars = args.maxChars ?? 8000;
      const rawHtml =
        html.length > maxChars ? `${html.slice(0, maxChars)}\n<!-- truncated -->` : html;
      const manualAuthTip = detectManualAuthCheckpoint(rawHtml);
      return sanitizeBrowserData({
        success: true,
        data: {
          url: wrap(url),
          title: wrap(title),
          html: wrap(rawHtml),
          ...(args.format !== "html" ? { note: "Text extraction failed on this page; returned raw HTML." } : {}),
          ...(manualAuthTip ? { manualAuthTip } : {}),
        },
      });
    }

    const sections = buildSections(raw.blocks);
    const plain = sections.map((x) => x.text).join(" ");
    const manualAuthTip = detectManualAuthCheckpoint(plain);
    const lookupTip = recordBrowseAction(session.page, "snapshot");
    const base = {
      url: wrap(url),
      title: wrap(title),
      ...(manualAuthTip ? { manualAuthTip } : {}),
      ...(lookupTip ? { lookupTip } : {}),
    };

    if (args.goal) {
      try {
        const ranking = await rankAgainstGoal(args.goal, sections, raw.elements, url);
        const f = formatRanking(ranking, url);
        const best = ranking.bestSectionScore;
        return sanitizeBrowserData({
          success: true,
          data: {
            ...base,
            goal: args.goal,
            content: wrap(f.content),
            elements: wrap(f.elements),
            confidence: best >= 2.3 ? "high" : best >= 1.5 ? "medium" : "low",
            hint:
              best >= 2.3
                ? "The answer is likely in content above."
                : "Content may not answer the goal — click the best-scoring element, or call browser_snapshot without goal to read the whole page.",
            pageStats: { sections: sections.length, elements: raw.elements.length },
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (base as Record<string, unknown>).goalError =
          msg === "JEV_AUTH_MISSING"
            ? "goal ranking needs Jev (Papr login or TYPESAFE_API_KEY) — returning the full page instead."
            : `goal ranking failed (${msg.slice(0, 160)}) — returning the full page instead.`;
      }
    }

    const maxChars = args.maxChars ?? 8000;
    const content = formatSections(sections, maxChars);
    const elements = formatElements(raw.elements, url, 150);
    return sanitizeBrowserData({
      success: true,
      data: {
        ...base,
        content: wrap(content.text),
        elements: wrap(elements.text),
        ...(content.truncated || elements.truncated
          ? { hint: "Page is long. Call browser_snapshot({ goal: \"...\" }) to get only the relevant parts." }
          : {}),
      },
    });
  },
});

export const browserClickTool = createTool({
  id: "browser_click",
  description:
    "Click an element on the current browser page. Prefer ref (the [N] number from browser_snapshot); selector is a fallback.",
  inputSchema: clickSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof clickSchema> }).context ?? input;
    const target = targetSelector(args);
    await assertBrowserToolAllowed("browser_click");
    await requestBrowserPermission(`click:${target}`);
    const session = await getBrowserSession();
    try {
      await session.page.click(target);
      recordBrowseAction(session.page, "click");
    } catch (error) {
      if (args.ref !== undefined) {
        throw new Error(
          `Element [${args.ref}] not found — the page changed since the last snapshot. Call browser_snapshot again. (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`,
        );
      }
      throw error;
    }
    return { success: true, data: { clicked: target } };
  },
});

export const browserTypeTool = createTool({
  id: "browser_type",
  description:
    "Fill text into an element on the current browser page. Prefer ref (the [N] number from browser_snapshot); selector is a fallback.",
  inputSchema: typeSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof typeSchema> }).context ?? input;
    const target = targetSelector(args);
    await assertBrowserToolAllowed("browser_type");
    await requestBrowserPermission(`type:${target}`);
    const session = await getBrowserSession();
    try {
      await session.page.fill(target, args.text);
    } catch (error) {
      if (args.ref !== undefined) {
        throw new Error(
          `Element [${args.ref}] not found — the page changed since the last snapshot. Call browser_snapshot again. (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`,
        );
      }
      throw error;
    }
    recordBrowseAction(session.page, "input");
    return { success: true, data: { selector: target } };
  },
});

export const browserTabsTool = createTool({
  id: "browser_tabs",
  description: "List or close browser sessions",
  inputSchema: tabsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof tabsSchema> }).context ?? input;
    await requestBrowserPermission(`tabs:${args.action}`);
    if (args.action === "close") {
      if (await closeChatPage()) {
        return { success: true, data: { closed: true, scope: "this chat's page" } };
      }
      await closeActiveBrowserSession();
      return { success: true, data: { closed: true } };
    }

    const session = await getBrowserSession();
    if (session.embeddedPlatformId) {
      return {
        success: true,
        data: {
          count: 1,
          pages: [
            {
              index: 0,
              title: await session.page.title(),
              url: session.page.url(),
            },
          ],
        },
      };
    }

    const pages = session.persistentContext
      ? session.persistentContext.pages()
      : (session.browser?.contexts().flatMap((context) => context.pages()) ?? [session.page]);
    const serialized = await Promise.all(
      pages.map(async (page, index) => ({
        index,
        title: await page.title(),
        url: page.url(),
      })),
    );
    return {
      success: true,
      data: {
        count: serialized.length,
        pages: serialized,
      },
    };
  },
});

export const browserConsoleLogsTool = createTool({
  id: "browser_console_logs",
  description:
    "Read browser console logs from the current session. Works after prepare_browser (Papr Chrome, headless Playwright, or embedded Electron fallback). Use to debug JS errors while reverse-engineering site APIs.",
  inputSchema: browserLogsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof browserLogsSchema> }).context ??
      input;
    await requestBrowserPermission("console_logs");
    const session = await getBrowserSession();
    const limit = args.limit ?? 50;

    if (session.embeddedPlatformId) {
      const data = await fetchEmbeddedPlatformLogs(
        session.embeddedPlatformId,
        "get_console_logs",
        limit,
        args.clearAfterRead,
      );
      return sanitizeBrowserData({
        success: true,
        data,
      }) as {
        success: boolean;
        data: { count: number; logs: BrowserConsoleLog[] };
      };
    }

    const logs = session.consoleLogs.slice(-limit);
    if (args.clearAfterRead) {
      session.consoleLogs.splice(0, session.consoleLogs.length);
    }
    return sanitizeBrowserData({
      success: true,
      data: {
        count: logs.length,
        logs,
      },
    }) as {
      success: boolean;
      data: { count: number; logs: BrowserConsoleLog[] };
    };
  },
});

export const browserNetworkLogsTool = createTool({
  id: "browser_network_logs",
  description:
    "Network tab for the current browser session — xhr/fetch URLs, methods, status codes. After prepare_browser on LinkedIn/social, use this (NOT bash curl) to discover APIs and debug empty pages. Works on Papr Chrome, headless Playwright, and embedded Electron fallback.",
  inputSchema: browserLogsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof browserLogsSchema> }).context ??
      input;
    await requestBrowserPermission("network_logs");
    const session = await getBrowserSession();
    const limit = args.limit ?? 50;

    if (session.embeddedPlatformId) {
      const data = await fetchEmbeddedPlatformLogs(
        session.embeddedPlatformId,
        "get_network_logs",
        limit,
        args.clearAfterRead,
      );
      return sanitizeBrowserData({
        success: true,
        data,
      }) as {
        success: boolean;
        data: { count: number; logs: BrowserNetworkLog[] };
      };
    }

    const logs = session.networkLogs.slice(-limit);
    if (args.clearAfterRead) {
      session.networkLogs.splice(0, session.networkLogs.length);
    }
    return sanitizeBrowserData({
      success: true,
      data: {
        count: logs.length,
        logs,
      },
    }) as {
      success: boolean;
      data: { count: number; logs: BrowserNetworkLog[] };
    };
  },
});

export const browserEvaluateScriptTool = createTool({
  id: "browser_test_script",
  description: "Run a browser page script for UI testing and return the result",
  inputSchema: browserScriptSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof browserScriptSchema> }).context ??
      input;
    await assertBrowserToolAllowed("browser_test_script");
    await requestBrowserPermission("test_script");
    const session = await getBrowserSession();
    try {
      const script = /(^|[;{}\n]\s*)return\b/.test(args.script) && !/^\s*\(/.test(args.script)
        ? `(() => { ${args.script} })()`
        : args.script;
      const result = await Promise.race([
        session.page.evaluate(script),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Script timed out after 10s")), 10000)
        ),
      ]);
      return sanitizeBrowserData({
        success: true,
        data: {
          url: session.page.url(),
          result,
        },
      }) as {
        success: boolean;
        data: { url: string; result: unknown };
      };
    } catch (error) {
      return {
        success: false,
        data: {
          url: session.page.url(),
          error: error instanceof Error ? error.message : String(error),
          timedOut: true,
        },
      };
    }
  },
});

export interface BrowserWaitInput {
  text?: string;
  textGone?: string;
  selector?: string;
  time?: number;
  timeout?: number;
}

export async function runBrowserWait(
  args: BrowserWaitInput,
): Promise<{
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}> {
  await requestBrowserPermission("wait_for");
  const session = await getBrowserSession();
  const timeoutMs = resolveWaitTimeoutMs(args.timeout);
  const pageUrl = session.page.url();

  const runWait = async (): Promise<{
    success: boolean;
    data?: Record<string, unknown>;
    error?: string;
  }> => {
    if (args.time !== undefined) {
      const seconds = resolveFixedDelaySeconds(args.time);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return { success: true, data: { waited: seconds, unit: "seconds" } };
    }

    const isBlankPage =
      !pageUrl || pageUrl === "about:blank" || pageUrl.startsWith("about:");
    if (isBlankPage && (args.text || args.textGone || args.selector)) {
      return {
        success: false,
        error:
          "Browser page is blank. Call browser_navigate first, or use page_wait_for({ target: 'mini_app', ... }) for mini-app previews.",
      };
    }

    if (args.text) {
      const page = requirePlaywrightPage(session);
      await page.waitForFunction(
        (text: string) => {
          // @ts-expect-error - runs in browser context
          return document.body?.innerText?.includes(text) ?? false;
        },
        args.text,
        { timeout: timeoutMs },
      );
      return { success: true, data: { found: args.text, url: pageUrl } };
    }

    if (args.textGone) {
      const page = requirePlaywrightPage(session);
      await page.waitForFunction(
        (text: string) => {
          // @ts-expect-error - runs in browser context
          return !document.body?.innerText?.includes(text);
        },
        args.textGone,
        { timeout: timeoutMs },
      );
      return { success: true, data: { gone: args.textGone, url: pageUrl } };
    }

    if (args.selector) {
      const page = requirePlaywrightPage(session);
      await page.waitForSelector(args.selector, {
        timeout: timeoutMs,
      });
      return {
        success: true,
        data: { found: args.selector, url: pageUrl },
      };
    }

    return {
      success: false,
      error: "Must specify text, textGone, selector, or time",
    };
  };

  try {
    return await Promise.race([
      runWait(),
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(`page_wait_for (browser) exceeded ${timeoutMs + 2000}ms`),
            ),
          timeoutMs + 2000,
        );
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut =
      message.includes("Timeout") ||
      message.includes("exceeded") ||
      message.includes("timed out");
    return {
      success: false,
      data: { url: pageUrl, timeoutMs, timedOut },
      error: timedOut
        ? `${message}. Use page_wait_for({ target: 'browser', ... }) after browser_navigate, or target: 'mini_app' after webview_launch_app.`
        : message,
    };
  }
}

export const browserFillFormTool = createTool({
  id: "browser_fill_form",
  description:
    "Fill multiple form fields at once. More efficient than multiple browser_type calls.",
  inputSchema: fillFormSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof fillFormSchema> }).context ?? input;
    await assertBrowserToolAllowed("browser_fill_form");
    await requestBrowserPermission(`fill_form:${args.fields.length} fields`);
    const session = await getBrowserSession();
    recordBrowseAction(session.page, "input");

    const results = [];
    for (const field of args.fields) {
      if (field.clear) {
        await session.page.fill(field.selector, "");
      }
      await session.page.fill(field.selector, field.value);
      results.push({ selector: field.selector, filled: true });
    }

    return {
      success: true,
      data: {
        filledCount: results.length,
        fields: results,
      },
    };
  },
});

export const browserScrollTool = createTool({
  id: "browser_scroll",
  description:
    "Scroll page by direction/amount or scroll element into view. " +
    "Required before clicking off-screen elements.",
  inputSchema: scrollSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof scrollSchema> }).context ?? input;
    await assertBrowserToolAllowed("browser_scroll");
    await requestBrowserPermission("scroll");
    const session = await getBrowserSession();

    if (args.selector) {
      const page = requirePlaywrightPage(session);
      await page.locator(args.selector).scrollIntoViewIfNeeded();
      return {
        success: true,
        data: { scrolledToElement: args.selector },
      };
    }

    let deltaX = args.deltaX ?? 0;
    let deltaY = args.deltaY ?? 0;

    if (args.direction) {
      const amount = args.amount ?? 300;
      switch (args.direction) {
        case "up":
          deltaY = -amount;
          break;
        case "down":
          deltaY = amount;
          break;
        case "left":
          deltaX = -amount;
          break;
        case "right":
          deltaX = amount;
          break;
      }
    }

    if (session.embeddedPlatformId) {
      await session.page.evaluate(
        `window.scrollBy(${deltaX}, ${deltaY}); return { deltaX: ${deltaX}, deltaY: ${deltaY} };`,
      );
    } else {
      const page = requirePlaywrightPage(session);
      await page.evaluate(
        ({ x, y }: { x: number; y: number }) => {
          // @ts-expect-error - This function runs in browser context
          window.scrollBy(x, y);
        },
        { x: deltaX, y: deltaY },
      );
    }

    return {
      success: true,
      data: { deltaX, deltaY },
    };
  },
});

async function settleSession(session: BrowserSessionState): Promise<void> {
  const url = session.page.url();
  const { waitForPlaywrightPageSettle, sleepForNavigationSettle } = await import(
    "../../gateway/services/platforms/platformBrowserSettle.js"
  );
  if (isPlaywrightPage(session.page)) {
    await waitForPlaywrightPageSettle(session.page, url, { platformId: session.platformId });
  } else {
    await sleepForNavigationSettle(url, session.platformId);
  }
}

const gotoSchema = z.object({
  goal: z
    .string()
    .min(3)
    .describe("What to find, e.g. 'Enterprise plan price', 'API rate limits', 'SAML SSO availability'"),
  url: z.string().url().optional().describe("Start here (default: the current page)"),
  maxSteps: z.number().int().min(1).max(8).optional().describe("Max pages to visit (default 5)"),
  allowOffsite: z.boolean().optional().describe("Follow links to other sites (default: same site only)"),
});

export const browserGotoTool = createTool({
  id: "browser_goto",
  description:
    "Find something on a website without reading every page. From the current page (or url), Jev scores each page's " +
    "sections and links against the goal, follows the most promising same-site link, and stops when a section clearly " +
    "answers it (up to maxSteps pages). Returns the best passages with their URLs, the path taken, and top elements on " +
    "the final page. Much cheaper than snapshot→click loops for lookups (pricing, docs, policies, specs). Use " +
    "browser_snapshot + browser_click for forms, logins, or step-by-step actions. Requires Jev (Papr login or TYPESAFE_API_KEY).",
  inputSchema: gotoSchema,
  execute: async (input) => {
    const args = (input as { context?: z.infer<typeof gotoSchema> }).context ?? input;
    await assertBrowserToolAllowed("browser_goto");
    await requestBrowserPermission(`goto:${args.url ?? "current page"} — find "${args.goal}"`);
    const session = await getBrowserSession();
    recordBrowseAction(session.page, "goto");
    const page = session.page;
    const adapter: GotoPage = {
      url: () => page.url(),
      goto: async (u) => {
        await page.goto(u, { waitUntil: "domcontentloaded" });
      },
      click: (sel) => page.click(sel),
      evaluate: (script) => page.evaluate(script),
      settle: () => settleSession(session),
    };
    let result;
    try {
      result = await withPageLock(page, async () => {
        if (args.url) {
          await adapter.goto(args.url);
          await adapter.settle();
        }
        return runGoto(adapter, args.goal, {
          maxSteps: args.maxSteps,
          allowOffsite: args.allowOffsite,
        });
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error:
          msg === "JEV_AUTH_MISSING"
            ? "browser_goto needs Jev (Papr login or TYPESAFE_API_KEY). Use browser_snapshot + browser_click instead."
            : `browser_goto failed: ${msg.slice(0, 300)}`,
      };
    }
    const ctx = `url: ${result.finalUrl}`;
    const wrap = (v: string) => wrapUntrustedContent("browser", ctx, v);
    const passages = result.passages
      .map((p) => `[${p.url}] ## ${p.path || "(top of page)"}  (score ${p.score.toFixed(2)})\n${p.text}`)
      .join("\n\n");
    const path = result.steps.map(
      (s) =>
        `${s.url} (best ${s.bestScore.toFixed(2)})` +
        (s.followed ? ` → "${s.followed.text}" (${s.followed.score.toFixed(2)})` : "") +
        (s.error ? ` [${s.error}]` : ""),
    );
    return sanitizeBrowserData({
      success: true,
      data: {
        found: result.found,
        confidence: result.confidence,
        stopReason: result.stopReason,
        finalUrl: wrap(result.finalUrl),
        passages: wrap(passages),
        path: wrap(path.join("\n")),
        elements: wrap(result.elements.join("\n")),
        ...(result.unvisited.length ? { unvisited: wrap(result.unvisited.join("\n")) } : {}),
        hint: result.found
          ? "Answer from passages and cite their URLs. If they don't actually contain the specific detail asked for, keep looking (next bullet) before answering."
          : "Not found yet — keep going yourself, don't ask the user: call browser_goto again starting from an unvisited link or the site's docs/help/support site (allowOffsite: true for a docs subdomain on another domain), or browser_snapshot({ goal }) + browser_click({ ref }) from finalUrl. Only report 'not published' after checking the docs/help site.",
      },
    });
  },
});

export const browserTools = [
  browserNavigateTool,
  browserSnapshotTool,
  browserGotoTool,
  browserClickTool,
  browserTypeTool,
  browserTabsTool,
  browserConsoleLogsTool,
  browserNetworkLogsTool,
  browserEvaluateScriptTool,
  browserFillFormTool,
  browserScrollTool,
];
