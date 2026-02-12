/**
 * Permissions IPC Handlers
 * 
 * Handles communication between:
 * - Gateway → Main (permission requests)
 * - Main → Renderer (show permission modal)
 * - Renderer → Main (user's permission response)
 */

import { ipcMain, type BrowserWindow } from "electron";
import type { KeyPermissionsStorage } from "../../core/storage/KeyPermissionsStorage.js";
import type { SettingsStorage } from "../../core/storage/SettingsStorage.js";
import type {
  KeyPermissionRequest,
  KeyPermissionResponse,
} from "../../core/types/permissions.js";

// Store pending permission requests
const pendingRequests = new Map<
  string,
  (response: KeyPermissionResponse) => void
>();

/**
 * Initialize permissions IPC handlers
 */
export function initializePermissionsIPC(
  keyPermStorage: KeyPermissionsStorage,
  settingsStorage: SettingsStorage,
  mainWindow: BrowserWindow
): void {
  console.log("[Permissions IPC] Initializing handlers...");

  // ===== From Renderer: Request permission for a key =====
  ipcMain.handle(
    "permissions:request-key",
    async (
      _event,
      request: KeyPermissionRequest
    ): Promise<KeyPermissionResponse> => {
      console.log(
        `[Permissions IPC] Key permission requested: ${request.keyName}`
      );

      // Check if key already has "always" permission
      if (
        request.isEnvKey &&
        keyPermStorage.getPermission(request.keyName) === "always"
      ) {
        console.log(
          `[Permissions IPC]   ✓ Key ${request.keyName} has "always" permission`
        );
        return { approved: true };
      }

      // Generate unique ID for this request
      const requestId = `perm-${Date.now()}-${Math.random()}`;

      console.log(
        `[Permissions IPC]   → Sending request to renderer (ID: ${requestId})`
      );

      // Send to renderer
      mainWindow.webContents.send("permissions:key-request", {
        ...request,
        requestId,
      });

      // Wait for response
      return new Promise((resolve) => {
        pendingRequests.set(requestId, (response) => {
          // Save "always allow" if requested
          if (response.approved && response.alwaysAllow && request.isEnvKey) {
            console.log(
              `[Permissions IPC]   ✓ Saving "always" permission for ${request.keyName}`
            );
            keyPermStorage.setPermission(request.keyName, "always");
          }

          resolve(response);
        });

        // Timeout after 30 seconds
        setTimeout(() => {
          if (pendingRequests.has(requestId)) {
            console.log(
              `[Permissions IPC]   ✗ Request ${requestId} timed out - denying`
            );
            pendingRequests.delete(requestId);
            resolve({ approved: false });
          }
        }, 30000);
      });
    }
  );

  // ===== From Renderer: User's response to permission request =====
  ipcMain.on(
    "permissions:key-response",
    (
      _event,
      data: {
        requestId: string;
        keyName: string;
        response: KeyPermissionResponse;
      }
    ) => {
      console.log(
        `[Permissions IPC] Response received for ${data.keyName}: ${data.response.approved ? "approved" : "denied"}`
      );

      const resolver = pendingRequests.get(data.requestId);

      if (resolver) {
        resolver(data.response);
        pendingRequests.delete(data.requestId);
      } else {
        console.warn(
          `[Permissions IPC]   ⚠ No pending request found for ID: ${data.requestId}`
        );
      }
    }
  );

  // ===== Get all permissions =====
  ipcMain.handle("permissions:get-all", async () => {
    console.log("[Permissions IPC] Getting all permissions");

    return {
      keyPermissions: keyPermStorage.getAll(),
      settings: settingsStorage.getPermissionSettings(),
    };
  });

  // ===== Update permission settings =====
  ipcMain.handle(
    "permissions:update-settings",
    async (_event, settings: any) => {
      console.log("[Permissions IPC] Updating permission settings");
      settingsStorage.setPermissionSettings(settings);
    }
  );

  // ===== Reset key permission =====
  ipcMain.handle("permissions:reset-key", async (_event, keyName: string) => {
    console.log(`[Permissions IPC] Resetting permission for ${keyName}`);
    keyPermStorage.resetPermission(keyName);
  });

  // ===== Get permission level =====
  ipcMain.handle("permissions:get-level", async () => {
    return settingsStorage.getPermissionLevel();
  });

  // ===== Set permission level =====
  ipcMain.handle("permissions:set-level", async (_event, level: string) => {
    settingsStorage.setPermissionLevel(level as any);
  });

  console.log("[Permissions IPC] Handlers initialized ✓");
}
