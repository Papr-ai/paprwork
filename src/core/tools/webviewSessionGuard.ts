import { clearWebviewPreviewActivity } from "./webviewActivity.js";

export interface WebviewBrowserBlockOptions {
  /** Papr Chrome / embedded platform tab from prepare_browser — not mini-app preview. */
  platformBrowserActive?: boolean;
}

export function shouldBlockBrowserToolsForWebviewPreview(
  activeWebviewSessions: boolean,
  options?: WebviewBrowserBlockOptions,
): boolean {
  if (options?.platformBrowserActive) {
    return false;
  }
  return activeWebviewSessions;
}

export async function listActiveWebviewSessionIds(): Promise<string[]> {
  try {
    const { requestWebviewTest } =
      await import("../../gateway/utils/webviewTestBridge.js");
    const response = await requestWebviewTest({ action: "list", payload: {} });
    if (!response.success || response.data === undefined) {
      return [];
    }
    const data = response.data as { sessions?: Array<{ id?: string }> };
    return Array.isArray(data.sessions) ? data.sessions.map((x) => String(x?.id ?? "")) : [];
  } catch {
    return [];
  }
}

export async function hasActiveWebviewSessions(): Promise<boolean> {
  return (await listActiveWebviewSessionIds()).length > 0;
}

/** Drop stale preview latch when Electron reports no headless webview sessions. */
export async function syncWebviewPreviewActivityLatch(): Promise<void> {
  const active = await hasActiveWebviewSessions();
  if (!active) {
    clearWebviewPreviewActivity();
  }
}

export async function getBrowserToolWebviewBlockReason(
  toolName: string,
  options?: WebviewBrowserBlockOptions,
): Promise<string | undefined> {
  const openIds = await listActiveWebviewSessionIds();
  const activeSessions = openIds.length > 0;
  if (!activeSessions) {
    clearWebviewPreviewActivity();
  }
  const previewOpen = shouldBlockBrowserToolsForWebviewPreview(
    activeSessions,
    options,
  );
  if (!previewOpen) {
    return undefined;
  }

  return (
    `${toolName} controls a separate Playwright browser, not the mini-app preview session. ` +
    "While webview_launch_app preview is open, use webview_fill_form, webview_click, or webview_execute " +
    "for DOM changes in the preview, or webview_close when finished. Use bash+curl for API/DB checks. " +
    `Open preview sessions: ${openIds.join(", ")} — close each with webview_close({ webviewId }) (a preview that reported "No active webview session" can still be open).`
  );
}
