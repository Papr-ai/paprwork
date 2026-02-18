/**
 * Gateway Permission Bridge
 * 
 * Bridges permission requests from Gateway to Main process.
 * Gateway runs as a subprocess and communicates with Main via process IPC.
 */

import type {
  KeyPermissionRequest,
  KeyPermissionResponse,
} from "../../core/types/permissions.js";
import type { RequestPermissionMessage } from "../../core/types/gateway-ipc.js";
import { isPermissionResponseMessage } from "../../core/types/gateway-ipc.js";

interface PendingPermissionRequest {
  resolve: (response: KeyPermissionResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

// Track pending permission requests
const pendingRequests = new Map<string, PendingPermissionRequest>();

let requestIdCounter = 0;

interface IpcProcessLike {
  send?: (message: unknown) => void;
  on: (event: "message", listener: (message: unknown) => void) => void;
}

/**
 * Request permission from Main process
 * Sends IPC message to parent (Electron main), waits for response
 */
export async function requestPermissionFromMain(
  request: KeyPermissionRequest,
  ipcProcess: IpcProcessLike = process,
): Promise<KeyPermissionResponse> {
  // Check if we're running as a subprocess (with parent process)
  if (!ipcProcess.send) {
    console.warn(
      "[GatewayPermissionBridge] Not running as subprocess, auto-approving permission"
    );
    return { approved: true };
  }

  const requestId = `gateway-perm-${++requestIdCounter}-${Date.now()}`;

  console.log(
    `[GatewayPermissionBridge] Requesting permission for ${request.keyName} (ID: ${requestId})`
  );

  // Send permission request to Main process
  const payload: RequestPermissionMessage = {
    type: "REQUEST_PERMISSION",
    requestId,
    request,
  };
  ipcProcess.send(payload);

  // Wait for response
  return new Promise((resolve, reject) => {
    // Timeout after 30 seconds
    const timeout = setTimeout(() => {
      const pending = pendingRequests.get(requestId);
      if (pending) {
        console.warn(
          `[GatewayPermissionBridge] Permission request ${requestId} timed out`
        );
        pendingRequests.delete(requestId);
        pending.reject(new Error("Permission request timed out"));
      }
    }, 30000);

    pendingRequests.set(requestId, { resolve, reject, timeout });
  });
}

/**
 * Handle permission response from Main process
 * Called by Gateway index when it receives IPC messages
 */
export function handlePermissionResponse(
  requestId: string,
  response: KeyPermissionResponse
): void {
  console.log(
    `[GatewayPermissionBridge] Received response for ${requestId}:`,
    response.approved ? "approved" : "denied"
  );

  const pending = pendingRequests.get(requestId);

  if (pending) {
    // Clear timeout
    clearTimeout(pending.timeout);
    pending.resolve(response);
    pendingRequests.delete(requestId);
  } else {
    console.warn(
      `[GatewayPermissionBridge] No pending request found for ${requestId}`
    );
  }
}

/**
 * Initialize permission response listener
 * Should be called once by Gateway on startup
 */
export function initializePermissionBridge(
  ipcProcess: IpcProcessLike = process,
): void {
  if (!ipcProcess.send) {
    console.warn(
      "[GatewayPermissionBridge] Not running as subprocess, permission bridge disabled"
    );
    return;
  }

  // Listen for permission responses from Main process
  ipcProcess.on("message", (msg: unknown) => {
    if (isPermissionResponseMessage(msg)) {
      handlePermissionResponse(msg.requestId, msg.response);
    }
  });

  console.log(
    "[GatewayPermissionBridge] Permission bridge initialized ✓"
  );
}
