import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { runBrowserWait } from "./browser.js";
import { runWebviewWait } from "./webview.js";
import { hasActiveWebviewSessions } from "./webviewSessionGuard.js";
import { hasRecentWebviewPreviewActivity } from "./webviewActivity.js";

async function shouldRouteToMiniAppPreview(): Promise<boolean> {
  return (
    hasRecentWebviewPreviewActivity() || (await hasActiveWebviewSessions())
  );
}

const waitParamsSchema = z.object({
  webviewId: z.string().optional(),
  text: z.string().optional(),
  textGone: z.string().optional(),
  selector: z.string().optional(),
  time: z.number().optional(),
  timeout: z.number().optional().default(30000),
});

const pageWaitSchema = waitParamsSchema.extend({
  target: z
    .enum(["mini_app", "browser"])
    .describe(
      "REQUIRED. mini_app = after webview_launch_app. browser = after browser_navigate.",
    ),
});

type WaitParams = z.infer<typeof waitParamsSchema>;
type PageWaitArgs = z.infer<typeof pageWaitSchema>;

async function executePageWait(
  args: PageWaitArgs,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  if (args.target === "mini_app") {
    return runWebviewWait({
      webviewId: args.webviewId,
      text: args.text,
      textGone: args.textGone,
      selector: args.selector,
      time: args.time,
      timeout: args.timeout,
    });
  }

  return runBrowserWait({
    text: args.text,
    textGone: args.textGone,
    selector: args.selector,
    time: args.time,
    timeout: args.timeout,
  });
}

function unwrapInput<T>(input: unknown): T {
  if (
    input &&
    typeof input === "object" &&
    "context" in input &&
    (input as { context?: T }).context !== undefined
  ) {
    return (input as { context: T }).context;
  }
  return input as T;
}

export const pageWaitForTool = createTool({
  id: "page_wait_for",
  description:
    "Wait for page content. Pick target based on what you are testing:\n" +
    "• target='mini_app' — AFTER webview_launch_app when verifying a Papr mini-app preview\n" +
    "• target='browser' — AFTER browser_navigate when testing external sites\n" +
    "Examples: page_wait_for({ target: 'mini_app', time: 2 }); page_wait_for({ target: 'browser', text: 'Sign in' })",
  inputSchema: pageWaitSchema,
  execute: async (input) => {
    const parsed = pageWaitSchema.safeParse(unwrapInput(input));
    if (!parsed.success) {
      return {
        success: false,
        error:
          "page_wait_for requires target: 'mini_app' (after webview_launch_app) or 'browser' (after browser_navigate).",
      };
    }
    return executePageWait(parsed.data);
  },
});

/** Models often call this after webview_launch_app — route to preview when active */
export const browserWaitForAliasTool = createTool({
  id: "browser_wait_for",
  description:
    "DEPRECATED — use page_wait_for. If a mini-app preview is open, waits in the preview; " +
    "otherwise waits in the headless browser (requires browser_navigate first).",
  inputSchema: waitParamsSchema,
  execute: async (input) => {
    const parsed = waitParamsSchema.safeParse(unwrapInput(input));
    const args: WaitParams = parsed.success
      ? parsed.data
      : waitParamsSchema.parse({});
    const target = (await shouldRouteToMiniAppPreview()) ? "mini_app" : "browser";
    const result = await executePageWait({ ...args, target });
    return {
      ...result,
      _routedTarget: target,
      _preferTool:
        target === "mini_app"
          ? "page_wait_for({ target: 'mini_app', ... })"
          : "page_wait_for({ target: 'browser', ... })",
    };
  },
});

export const webviewWaitForAliasTool = createTool({
  id: "webview_wait_for",
  description:
    "DEPRECATED — use page_wait_for({ target: 'mini_app', ... }) after webview_launch_app.",
  inputSchema: waitParamsSchema,
  execute: async (input) => {
    const parsed = waitParamsSchema.safeParse(unwrapInput(input));
    const args: WaitParams = parsed.success
      ? parsed.data
      : waitParamsSchema.parse({});
    return executePageWait({ ...args, target: "mini_app" });
  },
});

export const pageWaitTools = [
  pageWaitForTool,
  browserWaitForAliasTool,
  webviewWaitForAliasTool,
];
