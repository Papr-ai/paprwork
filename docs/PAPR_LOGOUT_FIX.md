# Papr Logout Button Not Working - Fix

**Added:** 2026-04-11  
**Status:** ✅ FIXED

## Problem

When users clicked the "Logout" button in Settings → AI Models → "Connected to Papr" section, nothing happened. The button appeared to be clicked but the UI didn't update to show the logged out state.

## Root Cause

The logout IPC handler (`papr:logout`) was correctly:
1. Removing the `PAPR_API_KEY` from keychain ✅
2. Clearing the Papr profile from settings ✅
3. Opening Auth0 logout URL in browser ✅

BUT it was **NOT notifying the renderer** that logout completed successfully. The frontend had no way to know the logout succeeded, so it kept showing "Connected to Papr" with the user's email.

## Solution

Added IPC event notification similar to the login success flow:

### 1. Backend Changes (IPC Handler)

**File:** `src/electron/ipc/paprLogin.ts`

Added `win.webContents.send("papr:logout-success")` after successful logout:

```typescript
// Logout — clear stored keys + OAuth tokens, open Auth0 logout
ipcMain.handle("papr:logout", async () => {
  try {
    const keys = await customKeysStorage.listKeys();

    for (const key of keys) {
      if (key.name === "PAPR_API_KEY" || key.name === "PAPR_ACCESS_TOKEN" || key.name === "PAPR_REFRESH_TOKEN") {
        await customKeysStorage.deleteKey(key.id);
      }
    }

    // Clear PKCE state
    loginState.codeVerifier = undefined;
    loginState.pendingState = undefined;

    settingsStorage.clearPaprProfile();
    console.log("[PaprLogin] Logged out, all tokens cleared.");

    // ✅ Notify renderer about logout success
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("papr:logout-success");
    }

    // Open Auth0 logout URL to clear browser session
    const logoutUrl = `https://${AUTH0_DOMAIN}/v2/logout?client_id=${AUTH0_CLIENT_ID}&returnTo=${encodeURIComponent("https://papr.ai")}`;
    shell.openExternal(logoutUrl);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Logout failed",
    };
  }
});
```

### 2. Preload Script Changes

**File:** `src/electron/preload.cjs`

Added `onLogoutSuccess` listener:

```javascript
papr: {
  checkLoginStatus: () => ipcRenderer.invoke("papr:check-login-status"),
  startLogin: () => ipcRenderer.invoke("papr:start-login"),
  logout: () => ipcRenderer.invoke("papr:logout"),
  getProfile: () => ipcRenderer.invoke("papr:get-profile"),
  onLoginSuccess: (callback) => {
    ipcRenderer.on("papr:login-success", (_event, data) => {
      callback(data);
      window.dispatchEvent(new CustomEvent('papr-auth-success', { detail: data }));
    });
  },
  // ✅ NEW: Listen for successful logout
  onLogoutSuccess: (callback) => {
    ipcRenderer.on("papr:logout-success", () => {
      callback();
      window.dispatchEvent(new CustomEvent('papr-logout-success'));
    });
  },
},
```

### 3. TypeScript Types

**File:** `ui/types/electron.d.ts`

Added type definition:

```typescript
papr: {
  // ... existing methods
  onLoginSuccess: (callback: (data: { apiKey: string; email: string }) => void) => void;
  onLogoutSuccess: (callback: () => void) => void; // ✅ NEW
};
```

### 4. Frontend Component Changes

**File:** `ui/components/Settings/PaprLoginSection.tsx`

Added logout success listener:

```typescript
// Listen for login success events from main process
useEffect(() => {
  // Register IPC listener for login success
  window.electronAPI.papr.onLoginSuccess((data) => {
    console.log('[PaprLoginSection] Login success received via IPC:', data);
    setIsLoggedIn(true);
    setUserEmail(data.email);
    setIsLoading(false);
    
    if (onApiKeyReceived) {
      onApiKeyReceived(data.apiKey);
    }
  });

  // ✅ NEW: Register IPC listener for logout success
  window.electronAPI.papr.onLogoutSuccess(() => {
    console.log('[PaprLoginSection] Logout success received via IPC');
    setIsLoggedIn(false);
    setUserEmail(null);
    
    // Dispatch DOM event for other components
    window.dispatchEvent(new CustomEvent('papr-logout-success'));
  });

  // Also listen for DOM events as backup
  const handleLoginSuccess = (event: CustomEvent) => { /* ... */ };
  const handleLoginError = (event: CustomEvent) => { /* ... */ };
  
  // ✅ NEW: DOM event listener
  const handleLogoutSuccess = () => {
    console.log('[PaprLoginSection] Logout success received via DOM event');
    setIsLoggedIn(false);
    setUserEmail(null);
  };

  window.addEventListener("papr-auth-success", handleLoginSuccess as EventListener);
  window.addEventListener("papr-login-error", handleLoginError as EventListener);
  window.addEventListener("papr-logout-success", handleLogoutSuccess as EventListener); // ✅ NEW

  return () => {
    window.removeEventListener("papr-auth-success", handleLoginSuccess as EventListener);
    window.removeEventListener("papr-login-error", handleLoginError as EventListener);
    window.removeEventListener("papr-logout-success", handleLogoutSuccess as EventListener); // ✅ NEW
  };
}, [onApiKeyReceived]);
```

### 5. API Keys List Refresh

**File:** `ui/components/Settings/SettingsView.tsx`

Added listener to refresh keys list after logout:

```typescript
function APIKeysTab() {
  const { keys: customKeys, loading, error, loadKeys, /* ... */ } = useCustomKeys();
  
  // ✅ NEW: Listen for logout success to refresh keys list
  useEffect(() => {
    const handleLogoutSuccess = () => {
      console.log('[APIKeysTab] Logout detected, reloading keys');
      loadKeys();
    };

    window.addEventListener("papr-logout-success", handleLogoutSuccess);
    return () => window.removeEventListener("papr-logout-success", handleLogoutSuccess);
  }, [loadKeys]);
  
  // ... rest of component
}
```

## Impact

- **Before:** Click logout → nothing visible happens → user confused → PAPR_API_KEY still shown in UI (even though deleted from keychain)
- **After:** Click logout → UI immediately updates to logged out state → "Login with Papr" button shown → API keys list refreshed ✅

## Testing Checklist

- [x] Click "Logout" button in Settings → AI Models
- [x] Verify UI changes from "Connected to Papr" to "Login with Papr"
- [x] Verify user email no longer displayed
- [x] Verify PAPR_API_KEY removed from API keys list
- [x] Verify browser opens Auth0 logout page
- [x] Console logs show: `[PaprLogin] Logged out, all tokens cleared.`
- [x] Console logs show: `[PaprLoginSection] Logout success received via IPC`
- [x] Console logs show: `[APIKeysTab] Logout detected, reloading keys`
- [x] Try logging in again → should work without issues

## Related Files

- `src/electron/ipc/paprLogin.ts` - IPC handler (sends logout success event)
- `src/electron/preload.cjs` - Exposes logout listener to renderer
- `ui/types/electron.d.ts` - TypeScript types
- `ui/components/Settings/PaprLoginSection.tsx` - Login/logout UI component
- `ui/components/Settings/SettingsView.tsx` - API keys list refresh

## Pattern

This follows the same pattern as login success:
1. Backend completes operation
2. Backend sends IPC event (`papr:logout-success`)
3. Preload script listens for IPC event
4. Preload script calls registered callback
5. Preload script dispatches DOM event (for other components)
6. Frontend updates UI state

## Prevention

Always notify the frontend when backend operations complete:
- Login → `papr:login-success`
- Logout → `papr:logout-success`
- OAuth connect → `oauth:connect-success`
- OAuth disconnect → `oauth:disconnect-success`

This keeps UI state in sync with backend state.
