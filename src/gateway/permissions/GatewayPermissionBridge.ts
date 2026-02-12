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

// Track pending permission requests
const pendingRequests = new Map<
  string,
  (response: KeyPermissionResponse) => void
>();

let requestIdCounter = 0;

/**
 * Request permission from Main process
 * Sends IPC message to parent (Electron main), waits for response
 */
export async function requestPermissionFromMain(
  request: KeyPermissionRequest
): Promise<KeyPermissionResponse> {
  // Check if we're running as a subprocess (with parent process)
  if (!process.send) {
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
  process.send({
    type: "REQUEST_PERMISSION",
    requestId,
    request,
  });

  // Wait for response
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, resolve);

    // Timeout after 30 seconds
    const timeout = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        console.warn(
          `[GatewayPermissionBridge] Permission request ${requestId} timed out`
        );
        pendingRequests.delete(requestId);
        reject(new Error("Permission request timed out"));
      }
    }, 30000);

    // Store timeout so we can clear it on response
    (pendingRequests.get(requestId) as any).timeout = timeout;
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

  const resolver = pendingRequests.get(requestId);

  if (resolver) {
    // Clear timeout
    const timeout = (resolver as any).timeout;
    if (timeout) {
      clearTimeout(timeout);
    }

    resolver(response);
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
export function initializePermissionBridge(): void {
  if (!process.send) {
    console.warn(
      "[GatewayPermissionBridge] Not running as subprocess, permission bridge disabled"
    );
    return;
  }

  // Listen for permission responses from Main process
  process.on("message", (msg: any) => {
    if (msg.type === "PERMISSION_RESPONSE") {
      handlePermissionResponse(msg.requestId, msg.response);
    }
  });

  console.log(
    "[GatewayPermissionBridge] Permission bridge initialized ✓"
  );
}
