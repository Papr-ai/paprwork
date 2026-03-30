/**
 * Papr Login IPC Handlers
 * 
 * Handles deep link OAuth flow with papr-dev-platform to automatically provision API keys
 */

import { ipcMain, BrowserWindow, shell } from "electron";
import { CustomKeysStorage, SettingsStorage } from "../../core/storage/index.js";

const PAPR_PLATFORM_URL = process.env.PAPR_PLATFORM_URL || "https://dashboard.papr.ai";

interface PaprLoginState {
  sessionToken?: string;
  apiKey?: string;
  email?: string;
  pendingState?: string;
}

const loginState: PaprLoginState = {};

/**
 * Generate secure random key for state parameter and CSRF protection
 */
function generateRandomKey(length: number = 32): string {
  const characters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const randomValues = new Uint8Array(length);
  
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(randomValues);
  } else {
    // Fallback for older Node versions
    const { randomBytes } = require("crypto");
    const bytes = randomBytes(length);
    for (let i = 0; i < length; i++) {
      randomValues[i] = bytes[i];
    }
  }
  
  let key = "";
  for (let i = 0; i < length; i++) {
    const value = randomValues[i];
    if (value !== undefined) {
      key += characters.charAt(value % characters.length);
    }
  }
  
  return key;
}

/**
 * Initialize Papr login IPC handlers
 */
export function initializePaprLoginIPC(
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage
) {
  // Register custom URL protocol handler for papr://
  // This will be called from index.cjs when app is ready
  
  // Check if user is already logged in
  ipcMain.handle("papr:check-login-status", async () => {
    try {
      // Check if we have a stored Papr API key
      const keys = await customKeysStorage.listKeys();
      const paprKey = keys.find((k) => k.name === "PAPR_API_KEY");

      return {
        success: true,
        isLoggedIn: !!paprKey,
        email: loginState.email || null,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to check login status",
      };
    }
  });

  // Start OAuth login flow
  ipcMain.handle("papr:start-login", async () => {
    try {
      // Generate random state for CSRF protection
      const state = generateRandomKey(32);
      loginState.pendingState = state;

      // Build login URL pointing to the desktop-login page (not direct auth)
      // The desktop-login page will store the state in localStorage, then redirect to Auth0
      const loginUrl = `${PAPR_PLATFORM_URL}/desktop-login?state=${state}`;
      
      // Open in browser
      await shell.openExternal(loginUrl);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to open dashboard",
      };
    }
  });

  // Logout
  ipcMain.handle("papr:logout", async () => {
    try {
      // Remove ALL keys named PAPR_API_KEY (handles both OAuth and manually-added)
      const keys = await customKeysStorage.listKeys();
      const paprKeys = keys.filter((k) => k.name === "PAPR_API_KEY");
      
      if (paprKeys.length > 0) {
        console.log(`[PaprLogin] Found ${paprKeys.length} PAPR_API_KEY(s) in keychain`);
        for (const key of paprKeys) {
          console.log(`[PaprLogin] Removing PAPR_API_KEY from keychain: ${key.id}`);
          await customKeysStorage.deleteKey(key.id);
        }
      } else {
        console.log("[PaprLogin] No PAPR_API_KEY found in keychain");
      }

      // Clear profile from settings
      settingsStorage.clearPaprProfile();
      console.log("[PaprLogin] Profile cleared from settings");

      // Clear login state
      loginState.sessionToken = undefined;
      loginState.apiKey = undefined;
      loginState.email = undefined;

      return { success: true };
    } catch (error) {
      console.error("[PaprLogin] Logout failed:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to logout",
      };
    }
  });

  // Get Papr profile
  ipcMain.handle("papr:get-profile", async () => {
    try {
      const profile = settingsStorage.getPaprProfile();
      return { success: true, profile };
    } catch (error) {
      console.error("[PaprLogin] Failed to get profile:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get profile",
      };
    }
  });
}

/**
 * Notify renderer process of successful login
 */
function notifyLoginSuccess(apiKey: string, email: string) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send("papr-login-success", { apiKey, email });
    }
  }
}

/**
 * Notify renderer process of login error
 */
function notifyLoginError(error: string) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send("papr-login-error", { error });
    }
  }
}

/**
 * Handle custom URL scheme callback from dashboard
 * Format: papr://auth/callback?api_key=xxx&state=xxx&email=xxx&user_id=xxx&display_name=xxx&profile_image=xxx
 */
export async function handlePaprAuthCallback(
  url: string,
  customKeysStorage: CustomKeysStorage,
  settingsStorage: SettingsStorage
): Promise<void> {
  try {
    const parsedUrl = new URL(url);
    
    // Validate it's our auth callback
    if (parsedUrl.protocol !== "papr:" || parsedUrl.host !== "auth" || parsedUrl.pathname !== "/callback") {
      console.log("[PaprLogin] Ignoring non-auth URL:", url);
      return;
    }

    // Extract parameters
    const apiKey = parsedUrl.searchParams.get("api_key");
    const state = parsedUrl.searchParams.get("state");
    const email = parsedUrl.searchParams.get("email");
    const userId = parsedUrl.searchParams.get("user_id");
    const displayName = parsedUrl.searchParams.get("display_name");
    const profileImage = parsedUrl.searchParams.get("profile_image");

    console.log("[PaprLogin] Received auth callback:", { 
      hasApiKey: !!apiKey, 
      state, 
      email, 
      userId,
      displayName,
      hasProfileImage: !!profileImage
    });

    // Validate state matches what we sent
    if (state !== loginState.pendingState) {
      console.error("[PaprLogin] State mismatch - possible CSRF attack");
      notifyLoginError("Security error: Invalid state parameter");
      return;
    }

    if (!apiKey) {
      console.error("[PaprLogin] No API key in callback");
      notifyLoginError("No API key received from dashboard");
      return;
    }

    // Store API key in CustomKeysStorage
    await customKeysStorage.addKey({
      name: "PAPR_API_KEY",
      value: apiKey,
    });

    // Store profile in settings (from URL params, no API call needed)
    settingsStorage.setPaprProfile({
      userId: userId || "",
      email: email || "",
      displayName: displayName || undefined,
      profileImage: profileImage || undefined,
      authenticatedAt: new Date().toISOString(),
    });
    console.log("[PaprLogin] Profile stored in settings from URL params");

    // Update login state
    loginState.apiKey = apiKey;
    loginState.email = email || undefined;
    loginState.pendingState = undefined;

    console.log("[PaprLogin] API key stored successfully");

    // Notify renderer process
    notifyLoginSuccess(apiKey, email || "");
  } catch (error) {
    console.error("[PaprLogin] Error handling auth callback:", error);
    notifyLoginError(error instanceof Error ? error.message : "Failed to process login");
  }
}

/**
 * Cleanup on app quit
 */
export function cleanupPaprLogin() {
  // Clean up any pending state
  loginState.pendingState = undefined;
}
