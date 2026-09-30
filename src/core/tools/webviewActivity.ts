/** Legacy latch — no longer used for browser_* blocking (see webviewSessionGuard). */
const WEBVIEW_ACTIVITY_MS = 15 * 60 * 1000;

let lastWebviewPreviewAt: number | null = null;

export function markWebviewPreviewActivity(): void {
  lastWebviewPreviewAt = Date.now();
}

export function clearWebviewPreviewActivity(): void {
  lastWebviewPreviewAt = null;
}

export function hasRecentWebviewPreviewActivity(): boolean {
  return (
    lastWebviewPreviewAt !== null &&
    Date.now() - lastWebviewPreviewAt < WEBVIEW_ACTIVITY_MS
  );
}
