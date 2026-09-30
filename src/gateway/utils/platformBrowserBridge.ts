import type {
  PlatformBrowserRequest,
  PlatformBrowserResponse,
  RequestPlatformBrowserMessage,
} from "../../core/types/platformBrowserIpc.js";
import { isPlatformBrowserResponseMessage } from "../../core/types/platformBrowserIpc.js";

interface PendingPlatformBrowserRequest {
  resolve: (response: PlatformBrowserResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface IpcProcessLike {
  send?: (message: unknown) => void;
  on: (event: "message", listener: (message: unknown) => void) => void;
}

const pendingRequests = new Map<string, PendingPlatformBrowserRequest>();
let requestCounter = 0;
let initialized = false;

export function isPlatformBrowserBridgeAvailable(
  ipcProcess: IpcProcessLike = process,
): boolean {
  return typeof ipcProcess.send === "function";
}

export function initializePlatformBrowserBridge(
  ipcProcess: IpcProcessLike = process,
): void {
  if (initialized || !ipcProcess.send) {
    return;
  }

  ipcProcess.on("message", (message: unknown) => {
    if (!isPlatformBrowserResponseMessage(message)) {
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

export async function requestPlatformBrowser(
  request: PlatformBrowserRequest,
  ipcProcess: IpcProcessLike = process,
  timeoutMs = 60_000,
): Promise<PlatformBrowserResponse> {
  if (!ipcProcess.send) {
    throw new Error(
      "Platform browser requires Gateway running as Electron child process",
    );
  }
  initializePlatformBrowserBridge(ipcProcess);

  const requestId = `platform-browser-${Date.now()}-${++requestCounter}`;
  const payload: RequestPlatformBrowserMessage = {
    type: "REQUEST_PLATFORM_BROWSER",
    requestId,
    request,
  };

  ipcProcess.send(payload);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(
        new Error(`Platform browser request timed out: ${request.action}`),
      );
    }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve,
      reject,
      timeout,
    });
  });
}
