import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { WebviewTestRequest } from "../types/gateway-ipc.js";
import { getApiKeysForSanitization, sanitizeToolOutput } from "./security.js";

const launchSchema = z.object({
  appId: z.string().min(1),
  visible: z.boolean().optional(),
  width: z.number().int().min(400).max(3840).optional(),
  height: z.number().int().min(300).max(2160).optional(),
});

const snapshotSchema = z.object({
  webviewId: z.string().optional(),
  maxHtmlChars: z.number().int().min(500).max(150000).optional(),
  maxTextChars: z.number().int().min(200).max(50000).optional(),
});

const executeSchema = z.object({
  webviewId: z.string().optional(),
  script: z.string().min(1),
});

const logsSchema = z.object({
  webviewId: z.string().optional(),
  limit: z.number().int().min(1).max(300).optional(),
  clearAfterRead: z.boolean().optional(),
});

const closeSchema = z.object({
  webviewId: z.string().optional(),
});

const webviewWaitForSchema = z.object({
  webviewId: z.string().optional(),
  text: z.string().optional().describe("Wait for this text in the preview"),
  textGone: z.string().optional().describe("Wait until this text disappears"),
  selector: z.string().optional().describe("Wait for CSS selector"),
  time: z
    .number()
    .optional()
    .describe("Fixed delay in seconds (e.g., 2 for SPA render)"),
  timeout: z
    .number()
    .optional()
    .default(30000)
    .describe("Max wait time in ms (capped at 30s)"),
});

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
  description: "Launch a mini-app in Electron webview test context",
  inputSchema: launchSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof launchSchema> }).context ?? input;
    const data = (await request("launch", {
      appId: args.appId,
      visible: args.visible ?? false,
      width: args.width ?? 1280,
      height: args.height ?? 720,
    })) as Record<string, unknown>;
    return {
      success: true,
      data,
      _testingReminder:
        "Use webview_wait_for ({ time: 2 }) or webview_snapshot to verify the preview. " +
        "Do NOT use browser_wait_for — it runs in a separate headless browser, not this preview.",
    };
  },
});

export const webviewWaitForTool = createTool({
  id: "webview_wait_for",
  description:
    "Wait in the mini-app preview webview (use after webview_launch_app). " +
    "Supports fixed delay ({ time: 2 }), text, selector, or textGone. Max 30s.",
  inputSchema: webviewWaitForSchema,
  execute: async (input) => {
    const raw =
      (input as { context?: z.infer<typeof webviewWaitForSchema> }).context ??
      input;
    const parsed = webviewWaitForSchema.safeParse(raw);
    const args = parsed.success ? parsed.data : webviewWaitForSchema.parse({});
    const data = await request("wait_for", {
      webviewId: args.webviewId,
      text: args.text,
      textGone: args.textGone,
      selector: args.selector,
      time: args.time,
      timeout: args.timeout,
    });
    return { success: true, data };
  },
});

export const webviewSnapshotTool = createTool({
  id: "webview_snapshot",
  description: "Capture HTML/text snapshot from webview app test context",
  inputSchema: snapshotSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof snapshotSchema> }).context ?? input;
    const data = await request("snapshot", {
      webviewId: args.webviewId,
      maxHtmlChars: args.maxHtmlChars ?? 80000,
      maxTextChars: args.maxTextChars ?? 12000,
    });
    return { success: true, data };
  },
});

export const webviewExecuteTool = createTool({
  id: "webview_execute",
  description: "Execute JavaScript in active webview test context",
  inputSchema: executeSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof executeSchema> }).context ?? input;
    const data = await request("execute", {
      webviewId: args.webviewId,
      script: args.script,
    });
    return { success: true, data };
  },
});

export const webviewGetConsoleTool = createTool({
  id: "webview_get_console",
  description: "Read captured webview console logs",
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
  webviewWaitForTool,
  webviewSnapshotTool,
  webviewExecuteTool,
  webviewGetConsoleTool,
  webviewGetNetworkTool,
  webviewListTool,
  webviewCloseTool,
];
