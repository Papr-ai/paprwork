# Windows Multiple Instance Issue - Single Instance Lock Fix

**Issue Date:** 2026-03-30  
**Status:** ✅ Fixed

## Problem

On Windows, when the deep link (`papr://auth/callback?...`) fired after browser authentication, it would launch a **new instance** of Paprwork showing the "Create Account" button, while the existing running instance remained stuck in "Waiting for login..." state.

## Root Cause

Electron on Windows launches a **new process** when a custom protocol (deep link) is triggered, unless explicitly prevented. The app did not have a **single instance lock** (`app.requestSingleInstanceLock()`), so:

1. User opens Paprwork → sees AuthWall "Waiting for login..."
2. User completes authentication in browser
3. Browser redirects to `papr://auth/callback?...`
4. **Windows launches NEW Paprwork instance** (not detected as duplicate)
5. New instance processes deep link → dismisses AuthWall
6. Original instance still waiting (never received deep link)

**Platform Difference:**
- **macOS**: Uses `open-url` event, sends deep link to existing instance ✅
- **Windows**: Launches new process unless single instance lock is set ❌
- **Linux**: Same as Windows ❌

## Solution

Added Electron's **single instance lock** to prevent multiple instances and forward deep links to the first instance.

### Implementation

**File:** `/src/electron/index.cjs`

```javascript
// Storage instances (shared between app.whenReady and second-instance handler)
let customKeysStorage;
let keyPermissionsStorage;
let settingsStorage;

// Single instance lock - prevent multiple instances on Windows/Linux
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[Electron] Another instance is already running, quitting');
  app.quit();
} else {
  // Handle second instance attempting to launch (e.g., from deep link on Windows)
  app.on('second-instance', async (event, commandLine, workingDirectory) => {
    console.log('[Electron] Second instance detected, focusing existing window');
    
    // Focus the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    
    // Check if the second instance was launched with a deep link
    const url = commandLine.find(arg => arg.startsWith('papr://'));
    if (url && handlePaprAuthCallback && customKeysStorage && settingsStorage) {
      console.log('[Electron] Second instance opened with deep link:', url);
      await handlePaprAuthCallback(url, customKeysStorage, settingsStorage);
    }
  });
}
```

### How It Works

1. **First instance starts:**
   - Acquires single instance lock (`gotTheLock = true`)
   - Continues normal initialization

2. **Second instance attempts to start (from deep link):**
   - Tries to acquire lock (`gotTheLock = false`)
   - Quits immediately
   - **Before quitting**, sends command line args to first instance via `second-instance` event

3. **First instance receives `second-instance` event:**
   - Extracts deep link URL from command line args
   - Focuses the existing window
   - Processes the deep link via `handlePaprAuthCallback`
   - Stores API key and profile
   - Dismisses AuthWall

### Key Design Decisions

**1. Storage Scope**
```javascript
// Declared at module level (not in app.whenReady)
let customKeysStorage;
let keyPermissionsStorage;
let settingsStorage;
```
**Why:** The `second-instance` handler needs access to the same storage instances as the main app logic. Declaring at module level allows both `app.whenReady()` and `app.on('second-instance')` to share the same instances.

**2. Window Focus**
```javascript
if (mainWindow) {
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}
```
**Why:** When deep link launches second instance, user expects to be brought back to the app. Focusing the window provides clear feedback that authentication succeeded.

**3. Command Line Parsing**
```javascript
const url = commandLine.find(arg => arg.startsWith('papr://'));
```
**Why:** On Windows, the deep link URL is passed as a command line argument to the second instance. We extract it from the `commandLine` array.

## The Complete Flow (After Fix)

### macOS (Already Worked)
1. User clicks "Create Account" → browser opens
2. User authenticates → browser redirects to `papr://auth/callback?...`
3. macOS sends `open-url` event to running Paprwork instance
4. Paprwork processes deep link → stores API key → dismisses AuthWall ✅

### Windows (Now Fixed!)
1. User clicks "Create Account" → browser opens
2. User authenticates → browser redirects to `papr://auth/callback?...`
3. Windows attempts to launch new Paprwork instance
4. **Single instance lock prevents new instance**
5. Command line args (deep link) sent to existing instance via `second-instance` event
6. Existing instance processes deep link → stores API key → dismisses AuthWall ✅

## Testing on Windows

### Scenario 1: Fresh Install
1. **Start app:** See AuthWall
2. **Click "Create Account":** Browser opens
3. **Complete auth:** Browser redirects to `papr://...`
4. **Result:** 
   - ✅ No new instance launches
   - ✅ Existing window focuses
   - ✅ AuthWall dismisses
   - ✅ App accessible

### Scenario 2: Already Running
1. **App already open**
2. **Open `papr://...` link directly** (e.g., from command line)
3. **Result:**
   - ✅ No new instance launches
   - ✅ Existing window focuses
   - ✅ Deep link processed

### Scenario 3: Minimized Window
1. **App running but minimized**
2. **Browser redirects to `papr://...`**
3. **Result:**
   - ✅ Window restores from minimized state
   - ✅ Window focuses
   - ✅ Deep link processed

## Console Output Verification

**First instance (already running):**
```
[Electron] App ready
[Electron] Second instance detected, focusing existing window
[Electron] Second instance opened with deep link: papr://auth/callback?api_key=***&state=...
[PaprLogin] Processing auth callback
[PaprLogin] Stored API key
[PaprLogin] Stored profile
[PaprLogin] Sending success event to renderer
```

**Second instance (attempted):**
```
[Electron] Another instance is already running, quitting
```

## Platform Compatibility

| Platform | Single Instance Lock | Deep Link Handling |
|----------|---------------------|-------------------|
| **macOS** | ✅ Works | `open-url` event |
| **Windows** | ✅ Works | `second-instance` + commandLine |
| **Linux** | ✅ Works | `second-instance` + commandLine |

## Performance Impact

| Metric | Impact | Notes |
|--------|--------|-------|
| First instance startup | No change | Lock acquisition is instant |
| Second instance attempt | Faster quit | Quits immediately (no window creation) |
| Deep link processing | No change | Same code path as before |

## Related Fixes

This fix complements the previous localStorage race condition fix:
1. **localStorage fix** (Enhancement 23): Ensures data persists on Windows
2. **Single instance lock** (Enhancement 24): Ensures deep link reaches the right instance

Together, these ensure reliable Papr login on Windows!

## Files Changed

- `/src/electron/index.cjs` - Added single instance lock and `second-instance` handler

## References

- [Electron: app.requestSingleInstanceLock()](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelock)
- [Electron: second-instance event](https://www.electronjs.org/docs/latest/api/app#event-second-instance)
- [Electron: Custom URL Schemes](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)

---

**Verified working on:** Windows 11, macOS 14.0, Ubuntu 22.04  
**Last tested:** 2026-03-30
