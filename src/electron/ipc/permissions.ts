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
  PermissionLevel,
  PermissionSettings,
} from "../../core/types/permissions.js";

interface PendingPermissionRequest {
  resolve: (response: KeyPermissionResponse) => void;
  timeout: NodeJS.Timeout;
}

interface RendererPermissionResponsePayload {
  requestId: string;
  keyName: string;
  response: KeyPermissionResponse;
}

let requestPermissionFromGatewayHandler:
  | ((request: KeyPermissionRequest) => Promise<KeyPermissionResponse>)
  | null = null;

// Store pending permission requests
const pendingRequests = new Map<string, PendingPermissionRequest>();

function isPermissionLevel(value: string): value is PermissionLevel {
  return value === "open" || value === "moderate" || value === "strict";
}

async function requestPermissionViaRenderer(
  request: KeyPermissionRequest,
  keyPermStorage: KeyPermissionsStorage,
  settingsStorage: SettingsStorage,
  mainWindow: BrowserWindow,
): Promise<KeyPermissionResponse> {
  if (mainWindow.isDestroyed()) {
    console.warn(
      "[Permissions IPC] Main window unavailable - denying permission",
    );
    return { approved: false };
  }

  // Check if key already has "always" permission (works for both env keys and tool keys like BROWSER_TOOL)
  if (keyPermStorage.getPermission(request.keyName) === "always") {
    console.log(
      `[Permissions IPC]   ✓ Key ${request.keyName} has "always" permission`,
    );
    return { approved: true };
  }

  // Check global permission level setting
  const permissionSettings = settingsStorage.getPermissionSettings();
  const permissionLevel = permissionSettings?.permissionLevel || "moderate";

  console.log(`[Permissions IPC]   Permission level: ${permissionLevel}`);

  // For "open" mode, auto-approve browser and most tools (except destructive operations)
  if (permissionLevel === "open") {
    const toolName = request.toolContext?.toolName || "";
    const isDestructive =
      toolName === "bash" &&
      (request.toolContext?.command?.includes("rm ") ||
        request.toolContext?.command?.includes("sudo ") ||
        request.toolContext?.command?.includes("kill "));

    if (!isDestructive) {
      console.log(
        `[Permissions IPC]   ✓ Auto-approved (Open mode, non-destructive)`,
      );
      return { approved: true };
    }
  }

  // Generate unique ID for this request
  const requestId = `perm-${Date.now()}-${Math.random()}`;

  console.log(
    `[Permissions IPC]   → Sending request to renderer (ID: ${requestId})`,
  );

  // Send to renderer
  mainWindow.webContents.send("permissions:key-request", {
    ...request,
    requestId,
  });

  // Wait for response
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        console.log(
          `[Permissions IPC]   ✗ Request ${requestId} timed out - denying`,
        );
        pendingRequests.delete(requestId);
        resolve({ approved: false });
      }
    }, 30000);

    pendingRequests.set(requestId, {
      resolve: (response) => {
        // Save "always allow" if requested (works for env keys and tool keys like BROWSER_TOOL)
        if (response.approved && response.alwaysAllow) {
          console.log(
            `[Permissions IPC]   ✓ Saving "always" permission for ${request.keyName}`,
          );
          keyPermStorage.setPermission(request.keyName, "always");
        }

        resolve(response);
      },
      timeout,
    });
  });
}

export async function requestPermissionFromGateway(
  request: KeyPermissionRequest,
): Promise<KeyPermissionResponse> {
  if (!requestPermissionFromGatewayHandler) {
    console.warn(
      "[Permissions IPC] Gateway requested permission before handlers initialized",
    );
    return { approved: false };
  }

  return requestPermissionFromGatewayHandler(request);
}

/**
 * Initialize permissions IPC handlers
 */
export function initializePermissionsIPC(
  keyPermStorage: KeyPermissionsStorage,
  settingsStorage: SettingsStorage,
  mainWindow: BrowserWindow,
): void {
  console.log("[Permissions IPC] Initializing handlers...");

  requestPermissionFromGatewayHandler = async (
    request: KeyPermissionRequest,
  ): Promise<KeyPermissionResponse> => {
    console.log(
      `[Permissions IPC] Gateway permission requested: ${request.keyName}`,
    );
    return requestPermissionViaRenderer(
      request,
      keyPermStorage,
      settingsStorage,
      mainWindow,
    );
  };

  // ===== From Renderer: Request permission for a key =====
  ipcMain.handle(
    "permissions:request-key",
    async (
      _event,
      request: KeyPermissionRequest,
    ): Promise<KeyPermissionResponse> => {
      console.log(
        `[Permissions IPC] Key permission requested: ${request.keyName}`,
      );
      return requestPermissionViaRenderer(
        request,
        keyPermStorage,
        settingsStorage,
        mainWindow,
      );
    },
  );

  // ===== From Renderer: User's response to permission request =====
  ipcMain.on(
    "permissions:key-response",
    (_event, data: RendererPermissionResponsePayload) => {
      console.log(
        `[Permissions IPC] Response received for ${data.keyName}: ${data.response.approved ? "approved" : "denied"}`,
      );

      const pending = pendingRequests.get(data.requestId);

      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(data.response);
        pendingRequests.delete(data.requestId);
      } else {
        console.warn(
          `[Permissions IPC]   ⚠ No pending request found for ID: ${data.requestId}`,
        );
      }
    },
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
    async (_event, settings: Partial<PermissionSettings>) => {
      console.log("[Permissions IPC] Updating permission settings");
      settingsStorage.setPermissionSettings(settings);
    },
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
    if (!isPermissionLevel(level)) {
      throw new Error(`Invalid permission level: ${level}`);
    }
    settingsStorage.setPermissionLevel(level);
  });

  console.log("[Permissions IPC] Handlers initialized ✓");
}
