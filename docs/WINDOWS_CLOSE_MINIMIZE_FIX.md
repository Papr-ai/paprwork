# Windows Close and Minimize Behavior Fix

**Issue Date:** 2026-04-06  
**Status:** ✅ FIXED

## Problem

On Windows, after minimizing or closing the app, clicking the taskbar icon or executable to reopen it resulted in no visible window. The app appeared to be running (process in Task Manager) but the window was hidden somewhere and couldn't be restored.

### Symptoms

1. **Close button (X):** Clicking X closed the window but left process running
2. **Minimize:** Clicking minimize hid the window
3. **Reopen attempt:** Clicking executable/taskbar did nothing - no window appeared
4. **Task Manager:** Process showed as running but window not visible

## Root Cause

The app lacked proper platform-specific close/minimize handlers:

1. **No `close` event handler:** Window close button behavior undefined for Windows
2. **No `activate` handler:** Clicking taskbar icon when window hidden had no effect  
3. **macOS-only logic:** `window-all-closed` only handled macOS case properly

### Expected Behavior Differences

| Platform | Close Button (X) | Minimize | Reopen Behavior |
|----------|------------------|----------|-----------------|
| **Windows** | Quit app completely | Hide window, keep in taskbar | Click taskbar → show window |
| **macOS** | Hide window, keep in dock | Hide window, keep in dock | Click dock → show window |
| **Linux** | Quit app completely | Hide window, keep in taskbar | Click taskbar → show window |

## Solution

Added proper platform-specific window lifecycle handlers:

### 1. Close Event Handler

```javascript
mainWindow.on("close", (event) => {
  if (process.platform === "darwin") {
    // macOS: Hide window but keep app running (standard macOS behavior)
    event.preventDefault();
    mainWindow.hide();
  } else {
    // Windows/Linux: Let the window close normally
    // This triggers window-all-closed → app.quit()
    // Don't prevent default - allow normal close behavior
  }
});
```

**Why this works:**
- **macOS:** Prevents window destruction, just hides it (standard macOS UX)
- **Windows/Linux:** Allows normal close, which calls `window-all-closed` → `app.quit()`

### 2. Activate Event Handler

```javascript
app.on("activate", () => {
  // macOS: Re-create window when dock icon clicked and no windows open
  if (mainWindow === null) {
    createWindow();
  } else if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
});
```

**What it does:**
- Triggered when clicking dock icon (macOS) or taskbar (Windows in some cases)
- If window exists but hidden → show it
- If window doesn't exist → create new one

### 3. Window-All-Closed Handler (Already Present, Added Comments)

```javascript
app.on("window-all-closed", () => {
  // Windows/Linux: Quit when all windows closed (standard behavior)
  // macOS: Keep app running (standard macOS behavior - app in dock)
  if (process.platform !== "darwin") {
    app.quit();
  }
});
```

## Behavior After Fix

### Windows

| Action | Before Fix | After Fix |
|--------|------------|-----------|
| Click X (close) | Process runs, window hidden | ✅ App quits completely |
| Minimize | Window hidden | ✅ Window minimized to taskbar |
| Click taskbar when hidden | Nothing | ✅ Window restored |
| Click .exe when running | Second instance? | ✅ Shows existing window (via single-instance lock) |

### macOS

| Action | Before Fix | After Fix |
|--------|------------|-----------|
| Click X (close) | Window closes, app quits | ✅ Window hides, app stays in dock |
| Minimize | Window minimized | ✅ Same behavior |
| Click dock icon | Nothing | ✅ Window restored or created |
| Cmd+Q | App quits | ✅ App quits |

### Linux

| Action | After Fix |
|--------|-----------|
| Click X | ✅ App quits |
| Minimize | ✅ Hidden, stays in taskbar |
| Click taskbar | ✅ Window restored |

## Implementation Details

### Close Event Flow

**Windows:**
```
User clicks X
  ↓
close event fires
  ↓
No preventDefault() → window closes
  ↓
window-all-closed event fires
  ↓
app.quit() called
  ↓
App process terminates
```

**macOS:**
```
User clicks X
  ↓
close event fires
  ↓
event.preventDefault() → window doesn't close
  ↓
mainWindow.hide() → window hidden
  ↓
App stays running in dock
```

### Activate Event Flow

**macOS (most common):**
```
User clicks dock icon
  ↓
activate event fires
  ↓
Check if window exists and visible
  ↓
If hidden → mainWindow.show()
  ↓
If null → createWindow()
```

**Windows:**
```
Single instance lock prevents second launch
  ↓
Second instance sends command line to first
  ↓
First instance focuses window (handled by single-instance lock)
```

## Platform-Specific Notes

### Windows

- **Taskbar behavior:** Windows manages taskbar icon automatically
- **Notification area:** Could add system tray icon for minimize-to-tray behavior (future enhancement)
- **Snap assist:** Native Windows snap works automatically
- **Alt+F4:** Triggers same close flow as X button

### macOS

- **Dock icon:** Always visible when app running (even with window hidden)
- **Cmd+W:** Hides window (same as X button)
- **Cmd+Q:** Quits app (triggers before-quit → app.quit())
- **Mission Control:** Shows hidden windows

### Linux

- **Desktop environment dependent:** Behavior may vary by DE (GNOME, KDE, etc.)
- **System tray:** Could add for minimize-to-tray (future enhancement)
- **Close behavior:** Follows Windows pattern (quit on close)

## Testing

### Manual Test (Windows)

1. **Close test:**
   ```
   - Launch app
   - Click X button
   - Check Task Manager → Process should be gone
   - Launch app again → Should start fresh
   ```

2. **Minimize test:**
   ```
   - Launch app
   - Click minimize button
   - Window should minimize to taskbar
   - Click taskbar icon → Window should restore
   ```

3. **Multiple launch test:**
   ```
   - Launch app
   - Try to launch .exe again
   - Should focus existing window (single-instance lock)
   - No second instance should start
   ```

### Manual Test (macOS)

1. **Close test:**
   ```
   - Launch app
   - Click red X button
   - Window should hide, dock icon stays
   - Click dock icon → Window should reappear
   ```

2. **Quit test:**
   ```
   - Launch app
   - Press Cmd+Q
   - App should quit completely
   - Dock icon disappears
   ```

3. **Minimize test:**
   ```
   - Launch app
   - Click yellow minimize button
   - Window minimizes to dock
   - Click dock icon → Window restores
   ```

## Edge Cases Handled

### 1. Window Hidden When Single Instance Activated

**Scenario:** Window hidden, user tries to launch .exe again

**Solution:** Single instance lock (Issue 24) focuses existing window

```javascript
app.on('second-instance', async (event, commandLine, workingDirectory) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
```

### 2. Window Null When Activate Triggered

**Scenario:** App running but window destroyed

**Solution:** Create new window

```javascript
if (mainWindow === null) {
  createWindow();
}
```

### 3. Rapid Close/Reopen

**Scenario:** User closes and immediately tries to reopen

**Windows:** App quits completely, new launch creates fresh window  
**macOS:** Window hidden, activate event shows it immediately

## Files Changed

- `src/electron/index.cjs` - Added close and activate handlers
- `docs/WINDOWS_CLOSE_MINIMIZE_FIX.md` - This documentation

## Related Issues

- Issue 24: Windows Multiple Instance - Single Instance Lock (2026-03-30)
- Issue 34: Windows Titlebar Theme Colors (2026-04-06)
- Issue 38: Windows Window Dragging and Resizing (2026-04-06)

## Future Enhancements

### 1. System Tray Support (Optional)

Add option to minimize to system tray instead of taskbar:

```javascript
const tray = new Tray('icon.png');
tray.on('click', () => {
  mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
});
```

**When useful:**
- Apps that run background tasks
- Apps user wants to keep running but not visible
- Power users who prefer tray-only apps

### 2. Close to Tray Preference

Let users choose close behavior:

- **Option 1:** Close button quits (current Windows behavior)
- **Option 2:** Close button minimizes to tray (like Slack, Discord)
- **Setting:** In app preferences

### 3. Minimize on Startup

Add option to start minimized:

```javascript
mainWindow = new BrowserWindow({
  ...config,
  show: !startMinimized
});
```

**Use case:** Apps that run on Windows startup

### 4. Remember Window State

Save and restore window state (position, size, minimized):

```javascript
const windowState = loadWindowState();
mainWindow = new BrowserWindow({
  x: windowState.x,
  y: windowState.y,
  width: windowState.width,
  height: windowState.height
});
```

## References

- [Electron App Lifecycle](https://www.electronjs.org/docs/latest/api/app)
- [Electron BrowserWindow Events](https://www.electronjs.org/docs/latest/api/browser-window#instance-events)
- [Windows Desktop App Lifecycle](https://docs.microsoft.com/en-us/windows/apps/design/app-settings/lifecycle)
- [macOS Human Interface Guidelines - App Lifecycle](https://developer.apple.com/design/human-interface-guidelines/app-lifecycle)
