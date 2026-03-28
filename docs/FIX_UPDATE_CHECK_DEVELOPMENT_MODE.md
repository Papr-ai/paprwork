# Fix: "Check for Updates" Button Not Working in Development Mode

**Date:** 2026-03-27
**Issue:** When clicking "Check for Updates" button in Settings > About, nothing happens
**Root Cause:** Auto-updater silently fails in development/unpackaged mode

## Problem

The auto-updater (`electron-updater`) only works in **packaged/production builds**. When running from source (`npm start`), the updater:
1. Fails silently when `checkForUpdates()` is called
2. Doesn't send any error status to the renderer
3. Leaves the UI in an unclear state

This is because:
- Electron can't verify code signatures in dev mode
- Update manifests require proper packaging
- GitHub Releases updates need signed builds

## Solution

Added proper error handling and user feedback:

### 1. Backend (Electron Main Process)

**File:** `src/electron/index.cjs`

Added development mode detection in the IPC handler:

```javascript
ipcMain.on("updater:check", () => {
  console.log("[AutoUpdater] Manual check requested");
  
  // Check if running in development/unpackaged mode
  if (!app.isPackaged) {
    console.log("[AutoUpdater] Skipping check - app is not packaged");
    sendUpdateStatus("error", { 
      error: "Updates are only available in packaged builds. Running from source doesn't support auto-updates." 
    });
    return;
  }
  
  autoUpdater.checkForUpdates().catch((err) => {
    console.error("[AutoUpdater] Manual check failed:", err.message);
    sendUpdateStatus("error", { error: err.message });
  });
});
```

Also added checks to skip automatic checks in development mode (on launch and periodic):

```javascript
// Skip auto-check in development mode
if (!app.isPackaged) {
  console.log("[AutoUpdater] Skipping check - app is not packaged");
  return;
}
```

### 2. Frontend (React UI)

**File:** `ui/components/Settings/SettingsView.tsx`

Added error notice display with helpful developer tips:

```tsx
{updateStatus?.status === "error" && updateStatus.error && (
  <div className="update-error-notice">
    <svg>...</svg>
    <div>
      <strong>Update Check Failed</strong>
      <p>{updateStatus.error}</p>
      {updateStatus.error.includes("not packaged") && (
        <p className="dev-mode-hint">
          💡 Tip: Auto-updates only work in production builds. To test updates, 
          run <code>npm run dist:mac</code> to create a packaged app.
        </p>
      )}
    </div>
  </div>
)}
```

**File:** `ui/components/Settings/SettingsView.css`

Added styling for the error notice:

```css
.update-error-notice {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: rgba(211, 47, 47, 0.1);
  border: 1px solid rgba(211, 47, 47, 0.3);
  border-radius: 6px;
  margin: 16px 0;
  color: #d32f2f;
}
```

## User Experience

### Before Fix
1. User clicks "Check for Updates"
2. Nothing happens (no feedback)
3. User is confused

### After Fix
1. User clicks "Check for Updates"
2. Error notice appears with clear message:
   - "Update Check Failed"
   - "Updates are only available in packaged builds..."
   - Helpful tip with command to create packaged build
3. User understands the limitation

## Testing

### Development Mode (npm start)
```bash
npm start
# Open Settings > About
# Click "Check for Updates"
# Should see error message explaining dev mode limitation
```

### Production Mode (packaged app)
```bash
npm run dist:mac
# Open the built app
open dist/mac/Paprwork.app
# Open Settings > About
# Click "Check for Updates"
# Should successfully check GitHub Releases
```

## Impact

- ✅ Clear user feedback in development mode
- ✅ No silent failures
- ✅ Helpful developer guidance
- ✅ Prevents unnecessary GitHub API calls in dev mode
- ✅ Better console logging for debugging

## Related Files

- `src/electron/index.cjs` - Main process auto-updater logic
- `ui/components/Settings/SettingsView.tsx` - About tab UI
- `ui/components/Settings/SettingsView.css` - Error notice styles
- `docs/APP_VERSION_AND_UPDATES.md` - Complete documentation

## Future Enhancements

- [ ] Add mock update server for development testing
- [ ] Show "Dev Mode" badge in version display
- [ ] Add "Simulate Update" button for UI testing
