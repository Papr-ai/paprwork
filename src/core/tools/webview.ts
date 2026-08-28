import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { WebviewTestRequest } from "../types/gateway-ipc.js";
import { getApiKeysForSanitization, sanitizeToolOutput } from "./security.js";
import { markWebviewPreviewActivity } from "./webviewActivity.js";

const launchSchema = z.object({
  appId: z.string().min(1),
  previewTarget: z
    .enum(["local", "published"])
    .optional()
    .describe(
      'Preview surface: "local" = desktop gateway /apps/{appId} (default). ' +
        '"published" = Web preview via gateway /cloud-preview/ (same as app tab Web toggle).',
    ),
  visible: z.boolean().optional(),
  width: z.number().int().min(400).max(3840).optional(),
  height: z.number().int().min(300).max(2160).optional(),
});

const snapshotSchema = z.object({
  webviewId: z.string().optional(),
  maxHtmlChars: z.number().int().min(500).max(150000).optional(),
  maxTextChars: z.number().int().min(200).max(50000).optional(),
  includeScreenshot: z
    .boolean()
    .optional()
    .describe("Capture a PNG thumbnail for chat UI preview"),
});

const executeSchema = z.object({
  webviewId: z.string().optional(),
  script: z
    .string()
    .min(1)
    .describe(
      "One-shot JS that RETURNS a value. For API/DB/job verification use bash+curl instead — NOT webview_execute.",
    ),
});

const logsSchema = z.object({
  webviewId: z.string().optional(),
  limit: z.number().int().min(1).max(300).optional(),
  clearAfterRead: z.boolean().optional(),
});

const closeSchema = z.object({
  webviewId: z.string().optional(),
});

const fillFormFieldSchema = z.object({
  selector: z.string().min(1).describe("CSS selector for input, textarea, or select"),
  value: z.string().describe("Value to set"),
  clear: z.boolean().optional().describe("Clear the field before filling"),
});

const fillFormSchema = z.object({
  webviewId: z.string().optional(),
  fields: z.array(fillFormFieldSchema).min(1).max(20),
});

const clickSchema = z.object({
  webviewId: z.string().optional(),
  selector: z.string().min(1).describe("CSS selector to click"),
});

export function buildWebviewFillFormScript(
  fields: Array<{ selector: string; value: string; clear?: boolean }>,
): string {
  return `(() => {
    const fields = ${JSON.stringify(fields)};
    const results = [];
    for (const field of fields) {
      const el = document.querySelector(field.selector);
      if (!el) {
        throw new Error("Element not found: " + field.selector);
      }
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea") {
        if (field.clear) {
          el.value = "";
        }
        el.value = field.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (tag === "select") {
        if (field.clear) {
          el.selectedIndex = 0;
        }
        el.value = field.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        throw new Error("Not a form control: " + field.selector + " (" + tag + ")");
      }
      results.push({ selector: field.selector, filled: true });
    }
    return { filledCount: results.length, fields: results };
  })()`;
}

export function buildWebviewClickScript(selector: string): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const el = document.querySelector(selector);
    if (!el) {
      throw new Error("Element not found: " + selector);
    }
    if (typeof el.click !== "function") {
      throw new Error("Element is not clickable: " + selector);
    }
    el.click();
    return { clicked: selector };
  })()`;
}

function sanitizeWebviewResult(data: unknown): unknown {
  const apiKeys = getApiKeysForSanitization();
  const sanitized = sanitizeToolOutput(data, apiKeys);
  // No truncation - prepareStep keeps last tool result full
  return sanitized;
}

async function request(
  action: WebviewTestRequest["action"],
  payload: Record<string, unknown>,
) {
  if (action !== "list" && action !== "close") {
    markWebviewPreviewActivity();
  }
  const { requestWebviewTest } =
    await import("../../gateway/utils/webviewTestBridge.js");
  const response = await requestWebviewTest({ action, payload });
  if (!response.success) {
    throw new Error(response.error || `Webview action failed: ${action}`);
  }
  return sanitizeWebviewResult(response.data);
}

export const webviewLaunchAppTool = createTool({
  id: "webview_launch_app",
  description:
    "Launch a headless mini-app preview session (always invisible — inline chat preview + screenshots show the UI). " +
    "previewTarget: 'local' (default) tests local files/DB; 'published' tests Web preview (cloud bundle + ACL via /cloud-preview/). " +
    "Then: page_wait_for({ target: 'mini_app', time: 2 }) → webview_get_console (runtime errors) → webview_snapshot (visual). " +
    "For API/DB/job verification use bash+curl to localhost:18789 — NOT webview_execute.",
  inputSchema: launchSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof launchSchema> }).context ?? input;
    const previewTarget = args.previewTarget ?? "local";
    const { resolveMiniAppPreviewLaunch } =
      await import("../../gateway/utils/miniAppPreviewUrl.js");
    const resolved = await resolveMiniAppPreviewLaunch(
      args.appId,
      previewTarget,
    );
    const data = await request("launch", {
      appId: args.appId,
      url: resolved.url,
      previewTarget: resolved.previewTarget,
      publishedWebUrl: resolved.publishedWebUrl,
      visible: false,
      width: args.width ?? 1280,
      height: args.height ?? 720,
    });
    return {
      success: true,
      data: {
        ...(data && typeof data === "object" ? data : {}),
        previewTarget: resolved.previewTarget,
        ...(resolved.publishedWebUrl
          ? { publishedWebUrl: resolved.publishedWebUrl }
          : {}),
      },
    };
  },
});

export interface WebviewWaitInput {
  webviewId?: string;
  text?: string;
  textGone?: string;
  selector?: string;
  time?: number;
  timeout?: number;
}

export async function runWebviewWait(
  args: WebviewWaitInput,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const data = await request("wait_for", {
      webviewId: args.webviewId,
      text: args.text,
      textGone: args.textGone,
      selector: args.selector,
      time: args.time,
      timeout: args.timeout,
    });
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const webviewSnapshotTool = createTool({
  id: "webview_snapshot",
  description:
    "Capture HTML + visible text + visualState from mini-app preview (NOT a screenshot, no vision tokens). " +
    "Check visualState.userWouldSeeBlankUi and visualState.warnings — DOM can look fine while overlays block the user. " +
    "Also use webview_get_console and webview_get_network for runtime errors and failed external requests.",
  inputSchema: snapshotSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof snapshotSchema> }).context ?? input;
    const data = await request("snapshot", {
      webviewId: args.webviewId,
      maxHtmlChars: args.maxHtmlChars ?? 80000,
      maxTextChars: args.maxTextChars ?? 12000,
      includeScreenshot: args.includeScreenshot ?? true,
    });
    return { success: true, data };
  },
});

export const webviewExecuteTool = createTool({
  id: "webview_execute",
  description:
    "One-shot DOM read/write in mini-app preview. Script MUST return a value. " +
    "Prefer webview_fill_form / webview_click for forms and buttons. " +
    "DO NOT use for API/DB/job checks — use bash+curl to localhost:18789 instead.",
  inputSchema: executeSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof executeSchema> }).context ?? input;
    const data = await request("execute", {
      webviewId: args.webviewId,
      script: args.script,
    });
    const result =
      data && typeof data === "object" && "result" in data
        ? (data as { result: unknown }).result
        : undefined;
    const execError =
      data && typeof data === "object" && "execError" in data
        ? String((data as { execError: unknown }).execError)
        : undefined;
    if (execError) {
      return {
        success: false,
        error: execError,
        data,
      };
    }
    const hint =
      result === undefined
        ? "Script returned undefined — add an explicit return value. For forms use webview_fill_form; for API/DB use bash+curl."
        : undefined;
    return { success: true, data, ...(hint ? { _hint: hint } : {}) };
  },
});

export const webviewFillFormTool = createTool({
  id: "webview_fill_form",
  description:
    "Fill form fields in the mini-app preview session (after webview_launch_app). " +
    "Use instead of browser_fill_form when testing Papr mini-apps — browser_* tools use a separate Playwright browser.",
  inputSchema: fillFormSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof fillFormSchema> }).context ?? input;
    const data = await request("execute", {
      webviewId: args.webviewId,
      script: buildWebviewFillFormScript(args.fields),
    });
    const execError =
      data && typeof data === "object" && "execError" in data
        ? String((data as { execError: unknown }).execError)
        : undefined;
    if (execError) {
      return { success: false, error: execError, data };
    }
    return { success: true, data };
  },
});

export const webviewClickTool = createTool({
  id: "webview_click",
  description:
    "Click an element in the mini-app preview session by CSS selector. " +
    "Use instead of browser_click when webview_launch_app preview is open.",
  inputSchema: clickSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof clickSchema> }).context ?? input;
    const data = await request("execute", {
      webviewId: args.webviewId,
      script: buildWebviewClickScript(args.selector),
    });
    const execError =
      data && typeof data === "object" && "execError" in data
        ? String((data as { execError: unknown }).execError)
        : undefined;
    if (execError) {
      return { success: false, error: execError, data };
    }
    return { success: true, data };
  },
});

export const webviewGetConsoleTool = createTool({
  id: "webview_get_console",
  description:
    "Read captured webview console logs — PRIMARY tool for runtime errors (ReferenceError, fetch failures). " +
    "Run after webview_launch_app before webview_execute or declaring preview broken.",
  inputSchema: logsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof logsSchema> }).context ?? input;
    const data = await request("get_console", {
      webviewId: args.webviewId,
      limit: args.limit ?? 100,
      clearAfterRead: args.clearAfterRead ?? false,
    });
    return { success: true, data };
  },
});

export const webviewGetNetworkTool = createTool({
  id: "webview_get_network",
  description: "Read captured webview network logs",
  inputSchema: logsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof logsSchema> }).context ?? input;
    const data = await request("get_network", {
      webviewId: args.webviewId,
      limit: args.limit ?? 100,
      clearAfterRead: args.clearAfterRead ?? false,
    });
    return { success: true, data };
  },
});

export const webviewListTool = createTool({
  id: "webview_list",
  description: "List active webview test sessions",
  inputSchema: z.object({}),
  execute: async () => {
    const data = await request("list", {});
    return { success: true, data };
  },
});

export const webviewCloseTool = createTool({
  id: "webview_close",
  description: "Close a webview test session",
  inputSchema: closeSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof closeSchema> }).context ?? input;
    const data = await request("close", { webviewId: args.webviewId });
    return { success: true, data };
  },
});

export const webviewTools = [
  webviewLaunchAppTool,
  webviewSnapshotTool,
  webviewFillFormTool,
  webviewClickTool,
  webviewExecuteTool,
  webviewGetConsoleTool,
  webviewGetNetworkTool,
  webviewListTool,
  webviewCloseTool,
];
