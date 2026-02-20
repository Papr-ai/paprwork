/**
 * Permission Requester
 *
 * Handles permission requests from tools in the Gateway process.
 * Communicates with Main process via IPC to show permission prompts to user.
 */

import type {
  KeyPermissionRequest,
  KeyPermissionResponse,
} from "../../core/types/permissions.js";

type PermissionRequestCallback = (
  request: KeyPermissionRequest,
) => Promise<KeyPermissionResponse>;

/**
 * Global permission requester instance
 * Set by Gateway on startup to enable tools to request permissions
 */
let globalPermissionRequester: PermissionRequestCallback | null = null;

/**
 * Set the global permission requester
 * Should be called once by Gateway during initialization
 */
export function setPermissionRequester(
  requester: PermissionRequestCallback,
): void {
  globalPermissionRequester = requester;
}

/**
 * Request permission for an API key
 * Used by tools (bash, etc.) to request user permission before using keys
 *
 * @param request - Permission request details
 * @returns Promise<KeyPermissionResponse>
 * @throws Error if permission requester not initialized
 */
export async function requestKeyPermission(
  request: KeyPermissionRequest,
): Promise<KeyPermissionResponse> {
  if (!globalPermissionRequester) {
    // If no requester is set, assume permission is granted
    // This happens in test/dev mode without Electron
    console.warn(
      "[PermissionRequester] No permission requester set, auto-approving",
    );
    return { approved: true };
  }

  return await globalPermissionRequester(request);
}

/**
 * Check if permission requester is available
 */
export function hasPermissionRequester(): boolean {
  return globalPermissionRequester !== null;
}
