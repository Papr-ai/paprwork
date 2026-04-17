import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Browser, Page } from "playwright";
import { getApiKeysForSanitization, sanitizeToolOutput } from "./security.js";
import { wrapUntrustedContent } from "./contentProvenance.js";

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

async function getBrowserSession(): Promise<BrowserSessionState> {
  if (browserSession) {
    return browserSession;
  }

  const module = await import("playwright");
  const browser = await module.chromium.launch({ headless: true });
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

const waitForSchema = z.object({
  text: z.string().optional().describe("Wait for this text to appear on page"),
  textGone: z
    .string()
    .optional()
    .describe("Wait for this text to disappear"),
  selector: z
    .string()
    .optional()
    .describe("Wait for this element selector"),
  time: z
    .number()
    .optional()
    .describe("Fixed delay in seconds (e.g., 2 for 2s, 0.5 for 500ms)"),
  timeout: z.number().optional().default(30000).describe("Max wait time in ms"),
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
    const result = await session.page.evaluate(args.script);
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
  },
});

export const browserWaitForTool = createTool({
  id: "browser_wait_for",
  description:
    "Wait for text/element to appear/disappear or fixed time delay. " +
    "Essential for SPAs that load content asynchronously.",
  inputSchema: waitForSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof waitForSchema> }).context ?? input;
    await requestBrowserPermission("wait_for");
    const session = await getBrowserSession();

    if (args.time) {
      await new Promise((resolve) => setTimeout(resolve, args.time! * 1000));
      return { success: true, data: { waited: args.time, unit: "seconds" } };
    }

    if (args.text) {
      await session.page.waitForFunction(
        (text: string) => {
          // @ts-expect-error - This function runs in browser context
          return document.body.innerText.includes(text);
        },
        args.text,
        { timeout: args.timeout },
      );
      return { success: true, data: { found: args.text } };
    }

    if (args.textGone) {
      await session.page.waitForFunction(
        (text: string) => {
          // @ts-expect-error - This function runs in browser context
          return !document.body.innerText.includes(text);
        },
        args.textGone,
        { timeout: args.timeout },
      );
      return { success: true, data: { gone: args.textGone } };
    }

    if (args.selector) {
      await session.page.waitForSelector(args.selector, {
        timeout: args.timeout,
      });
      return { success: true, data: { found: args.selector } };
    }

    throw new Error("Must specify text, textGone, selector, or time");
  },
});

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
  browserWaitForTool,
  browserFillFormTool,
  browserScrollTool,
];
