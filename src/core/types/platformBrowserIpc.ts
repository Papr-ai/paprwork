/**
 * IPC between Gateway and Electron main for in-app platform browser tabs.
 */

export type PlatformBrowserAction =
  | "ensure"
  | "ensure_cdp"
  | "navigate"
  | "snapshot"
  | "click"
  | "fill"
  | "execute"
  | "get_state"
  | "get_console_logs"
  | "get_network_logs"
  | "extract_cookies"
  | "inject_cookies"
  | "hide"
  | "show_tab";

export interface PlatformBrowserRequest {
  action: PlatformBrowserAction;
  payload?: Record<string, unknown>;
}

export interface RequestPlatformBrowserMessage {
  type: "REQUEST_PLATFORM_BROWSER";
  requestId: string;
  request: PlatformBrowserRequest;
}

export interface PlatformBrowserResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PlatformBrowserResponseMessage {
  type: "PLATFORM_BROWSER_RESPONSE";
  requestId: string;
  response: PlatformBrowserResponse;
}

export function isPlatformBrowserResponseMessage(
  message: unknown,
): message is PlatformBrowserResponseMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === "PLATFORM_BROWSER_RESPONSE" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.response === "object" &&
    candidate.response !== null
  );
}
