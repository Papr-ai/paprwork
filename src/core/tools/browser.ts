import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { execSync } from "node:child_process";
import type { Browser, Page } from "playwright";
import { isCloudAgentGatewayMode } from "../utils/paprRoot.js";
import { getApiKeysForSanitization, sanitizeToolOutput } from "./security.js";
import { wrapUntrustedContent } from "./contentProvenance.js";

// Track if we've already tried installing Playwright browsers
let playwrightInstallAttempted = false;

interface BrowserSessionState {
  browser: Browser;
  page: Page;
  consoleLogs: BrowserConsoleLog[];
  networkLogs: BrowserNetworkLog[];
}

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
}

/**
 * Inject stored Social Login cookies into the agent's headless browser and verify auth.
 * Call this before browser_navigate / browser_snapshot on a connected platform.
 */
export async function preparePlatformBrowserSession(
  platformId: string,
  targetUrl?: string,
): Promise<PlatformBrowserPrepareResult> {
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
      error: `Status: ${status.status}. Use connect_platform request_connect or Settings → Social Login.`,
    };
  }

  const cookies = await sessionService.getSessionCookiesForBrowser(platformId as PlatformId);
  if (cookies.length === 0) {
    return {
      success: false,
      url: "",
      title: "",
      message: `No session cookies found for ${config.name}.`,
      error: "Reconnect via Settings → Social Login.",
    };
  }

  const session = await getBrowserSession();
  await session.page.context().addCookies(cookies);

  const destination = targetUrl ?? config.homeUrl;
  await session.page.goto(destination, {
    waitUntil: "domcontentloaded",
    timeout: PLATFORM_NAVIGATION_TIMEOUT_MS,
  });

  const currentUrl = session.page.url();
  const title = await session.page.title();

  const authenticated = config.successUrlPattern.test(currentUrl);
  const loggedOut =
    !authenticated &&
    (/\/login(?:\/|$|\?)/i.test(currentUrl) ||
      /\/signin(?:\/|$|\?)/i.test(currentUrl) ||
      /\/checkpoint(?:\/|$|\?)/i.test(currentUrl));

  if (loggedOut) {
    return {
      success: false,
      url: currentUrl,
      title,
      message: `${config.name} session expired — redirected to login.`,
      error: "Reconnect via Settings → Social Login.",
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

async function getBrowserSession(): Promise<BrowserSessionState> {
  if (browserSession) {
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

    if (!playwrightInstallAttempted && isPlaywrightMissingError(errorMessage)) {
      console.log("[Browser Tool] Playwright not found, installing Chromium...");
      console.log("[Browser Tool] Error was:", errorMessage);
      playwrightInstallAttempted = true;

      try {
        execSync("npx playwright install chromium", {
          stdio: "inherit",
          timeout: 5 * 60 * 1000,
        });
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
  };
  if (isCloudAgentGatewayMode() || process.env.PLAYWRIGHT_DOCKER === "1") {
    launchOptions.args = [
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
    if (!playwrightInstallAttempted && isPlaywrightMissingError(errorMessage)) {
      console.log(
        "[Browser Tool] Playwright browsers not found, installing Chromium...",
      );
      playwrightInstallAttempted = true;

      try {
        // Install only Chromium (faster than all browsers)
        execSync("npx playwright install chromium", {
          stdio: "inherit",
          timeout: 5 * 60 * 1000, // 5 minute timeout for download
        });
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
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleLogs: BrowserConsoleLog[] = [];
  const networkLogs: BrowserNetworkLog[] = [];

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

  browserSession = { browser, page, consoleLogs, networkLogs };
  return browserSession;
}

const navigateSchema = z.object({
  url: z.string().url(),
});

const snapshotSchema = z.object({
  maxChars: z.number().int().min(200).max(100000).optional(),
});

const clickSchema = z.object({
  selector: z.string().min(1),
});

const typeSchema = z.object({
  selector: z.string().min(1),
  text: z.string(),
});

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
  description: "Navigate the browser session to a URL",
  inputSchema: navigateSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof navigateSchema> }).context ?? input;
    await requestBrowserPermission(`navigate:${args.url}`);
    const session = await getBrowserSession();
    await session.page.goto(args.url, { waitUntil: "domcontentloaded" });
    const url = session.page.url();
    const title = await session.page.title();
    const ctx = `url: ${url}`;
    return sanitizeBrowserData({
      success: true,
      data: {
        url: wrapUntrustedContent("browser", ctx, url),
        title: wrapUntrustedContent("browser", ctx, title),
      },
    }) as { success: boolean; data: { url: string; title: string } };
  },
});

export const browserSnapshotTool = createTool({
  id: "browser_snapshot",
  description: "Capture a compact HTML snapshot from current page",
  inputSchema: snapshotSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof snapshotSchema> }).context ?? input;
    await requestBrowserPermission("snapshot");
    const session = await getBrowserSession();
    const html = await session.page.content();
    const maxChars = args.maxChars ?? 8000;
    const url = session.page.url();
    const title = await session.page.title();
    const rawHtml =
      html.length > maxChars
        ? `${html.slice(0, maxChars)}\n<!-- truncated -->`
        : html;
    const ctx = `url: ${url}`;
    return sanitizeBrowserData({
      success: true,
      data: {
        url: wrapUntrustedContent("browser", ctx, url),
        title: wrapUntrustedContent("browser", ctx, title),
        html: wrapUntrustedContent("browser", ctx, rawHtml),
      },
    }) as {
      success: boolean;
      data: { url: string; title: string; html: string };
    };
  },
});

export const browserClickTool = createTool({
  id: "browser_click",
  description: "Click an element on the current browser page",
  inputSchema: clickSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof clickSchema> }).context ?? input;
    await requestBrowserPermission(`click:${args.selector}`);
    const session = await getBrowserSession();
    await session.page.click(args.selector);
    return { success: true, data: { clicked: args.selector } };
  },
});

export const browserTypeTool = createTool({
  id: "browser_type",
  description: "Fill text into an element on the current browser page",
  inputSchema: typeSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof typeSchema> }).context ?? input;
    await requestBrowserPermission(`type:${args.selector}`);
    const session = await getBrowserSession();
    await session.page.fill(args.selector, args.text);
    return { success: true, data: { selector: args.selector } };
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
      if (browserSession) {
        await browserSession.browser.close();
        browserSession = null;
      }
      return { success: true, data: { closed: true } };
    }

    const session = await getBrowserSession();
    const contexts = session.browser.contexts();
    const pages = contexts.flatMap((context) => context.pages());
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
  description: "Read browser console logs from current session",
  inputSchema: browserLogsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof browserLogsSchema> }).context ??
      input;
    await requestBrowserPermission("console_logs");
    const session = await getBrowserSession();
    const limit = args.limit ?? 50;
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
  description: "Read browser network response logs from current session",
  inputSchema: browserLogsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof browserLogsSchema> }).context ??
      input;
    await requestBrowserPermission("network_logs");
    const session = await getBrowserSession();
    const limit = args.limit ?? 50;
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
    await requestBrowserPermission("test_script");
    const session = await getBrowserSession();
    try {
      const result = await Promise.race([
        session.page.evaluate(args.script),
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
      await session.page.waitForFunction(
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
      await session.page.waitForFunction(
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
      await session.page.waitForSelector(args.selector, {
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
    await requestBrowserPermission(`fill_form:${args.fields.length} fields`);
    const session = await getBrowserSession();

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
    await requestBrowserPermission("scroll");
    const session = await getBrowserSession();

    if (args.selector) {
      await session.page.locator(args.selector).scrollIntoViewIfNeeded();
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

    await session.page.evaluate(
      ({ x, y }: { x: number; y: number }) => {
        // @ts-expect-error - This function runs in browser context
        window.scrollBy(x, y);
      },
      { x: deltaX, y: deltaY },
    );

    return {
      success: true,
      data: { deltaX, deltaY },
    };
  },
});

export const browserTools = [
  browserNavigateTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserTabsTool,
  browserConsoleLogsTool,
  browserNetworkLogsTool,
  browserEvaluateScriptTool,
  browserFillFormTool,
  browserScrollTool,
];
