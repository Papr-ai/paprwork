import type {
  RequestWebviewTestMessage,
  WebviewTestResponse,
  WebviewTestRequest,
} from "../../core/types/gateway-ipc.js";
import { isWebviewTestResponseMessage } from "../../core/types/gateway-ipc.js";
import { isCloudAgentGatewayMode } from "../../core/utils/paprRoot.js";

/** Cloud agent gateway, or opted in for local testing. */
export function isHeadlessWebviewHostEnabled(): boolean {
  return isCloudAgentGatewayMode() || process.env.PAPR_HEADLESS_WEBVIEW === "1";
}

interface PendingWebviewRequest {
  resolve: (response: WebviewTestResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface IpcProcessLike {
  send?: (message: unknown) => void;
  on: (event: "message", listener: (message: unknown) => void) => void;
}

const pendingRequests = new Map<string, PendingWebviewRequest>();
let requestCounter = 0;
let initialized = false;

export function initializeWebviewTestBridge(
  ipcProcess: IpcProcessLike = process,
): void {
  if (initialized || !ipcProcess.send) {
    return;
  }

  ipcProcess.on("message", (message: unknown) => {
    if (!isWebviewTestResponseMessage(message)) {
      return;
    }
    const pending = pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.requestId);
    pending.resolve(message.response);
  });
  initialized = true;
}

export async function requestWebviewTest(
  request: WebviewTestRequest,
  ipcProcess: IpcProcessLike = process,
): Promise<WebviewTestResponse> {
  if (!ipcProcess.send) {
    // No Electron parent. Cloud agent runs use headless Chromium, which the
    // image already ships for browser_* tools; anywhere else keep failing loudly.
    if (!isHeadlessWebviewHostEnabled()) {
      throw new Error(
        "Webview testing requires Gateway running as Electron child process",
      );
    }
    const { handleHeadlessWebviewRequest } = await import("./headlessWebviewHost.js");
    return handleHeadlessWebviewRequest(request);
  }
  initializeWebviewTestBridge(ipcProcess);
  const requestId = `webview-${Date.now()}-${++requestCounter}`;

  const payload: RequestWebviewTestMessage = {
    type: "REQUEST_WEBVIEW_TEST",
    requestId,
    request,
  };

  ipcProcess.send(payload);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Webview test request timed out: ${request.action}`));
    }, 30000);

    pendingRequests.set(requestId, {
      resolve,
      reject,
      timeout,
    });
  });
}
