import { hasRecentWebviewPreviewActivity } from "./webviewActivity.js";

export async function hasActiveWebviewSessions(): Promise<boolean> {
  try {
    const { requestWebviewTest } =
      await import("../../gateway/utils/webviewTestBridge.js");
    const response = await requestWebviewTest({ action: "list", payload: {} });
    if (!response.success || response.data === undefined) {
      return false;
    }
    const data = response.data as { sessions?: unknown[] };
    return Array.isArray(data.sessions) && data.sessions.length > 0;
  } catch {
    return false;
  }
}

export async function getBrowserToolWebviewBlockReason(
  toolName: string,
): Promise<string | undefined> {
  const previewOpen =
    hasRecentWebviewPreviewActivity() || (await hasActiveWebviewSessions());
  if (!previewOpen) {
    return undefined;
  }

  return (
    `${toolName} controls a separate Playwright browser, not the mini-app preview session. ` +
    "While webview_launch_app preview is open, use webview_fill_form, webview_click, or webview_execute " +
    "for DOM changes in the preview. Use bash+curl for API/DB checks."
  );
}
