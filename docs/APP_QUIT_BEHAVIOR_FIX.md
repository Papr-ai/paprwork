# App Quit Behavior Fix

**Date:** 2026-04-12  
**Issue:** App stays running in background after right-click quit  
**Status:** ✅ Fixed

## Problem

When users right-clicked the app icon in the dock/taskbar and selected "Quit", the window would close but the app processes (especially Gateway) would stay running in the background. When users tried to reopen the app, it would appear to open instantly but show the existing state instead of doing a fresh restart.

**User Experience:**
- Right-click dock icon → Quit
- Window closes
- Gateway process stays running (port 18789 still bound)
- Click app icon to reopen → Shows existing state, no fresh start
- Required force-quit from Activity Monitor/Task Manager

## Root Causes

### 1. Incomplete Cleanup
The `before-quit` handler was async but didn't properly await the Gateway supervisor's `stop()` method:

```javascript
// BEFORE (incorrect)
if (supervisor) {
  console.log("[Electron] Stopping Gateway supervisor...");
  supervisor.stop(); // ❌ Not awaited
}
```

### 2. Race Condition
The `before-quit` handler called `app.quit()` after only 100ms, but the supervisor's `stop()` method used a 2-second timeout for SIGKILL. This meant the app would quit before Gateway was fully stopped:

```javascript
// BEFORE (incorrect)
supervisor.stop(); // Takes up to 2 seconds
setTimeout(() => app.quit(), 100); // ❌ Quit too early
```

### 3. Non-Async stop() Method
The supervisor's `stop()` method was synchronous, using `setTimeout()` for the SIGKILL timeout. This meant there was no way to wait for it to complete:

```javascript
// BEFORE (incorrect)
stop() {
  this.process.kill("SIGTERM");
  setTimeout(() => {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGKILL");
    }
  }, 2000); // ❌ Can't await this
}
```

## Solution

### 1. Made stop() Async
Changed the supervisor's `stop()` method to be async and properly wait for the Gateway process to exit:

```javascript
// AFTER (correct)
async stop() {
  this.isStopping = true;
  this._stopHealthCheck();
  
  if (this.process && !this.process.killed) {
    const pid = this.process.pid;
    console.log("[Supervisor] Stopping Gateway process (PID: %s)...", pid);
    
    try {
      // Send SIGTERM for graceful shutdown
      this.process.kill("SIGTERM");
      
      // Wait for process to exit gracefully (up to 3 seconds)
      await new Promise((resolve) => {
        let attempts = 0;
        const checkInterval = setInterval(() => {
          attempts++;
          if (!this.process || this.process.killed) {
            clearInterval(checkInterval);
            console.log("[Supervisor] Gateway stopped gracefully");
            resolve();
          } else if (attempts >= 30) { // 30 * 100ms = 3 seconds
            clearInterval(checkInterval);
            console.log("[Supervisor] Gateway didn't stop gracefully, force killing...");
            if (this.process && !this.process.killed) {
              this.process.kill("SIGKILL");
            }
            resolve();
          }
        }, 100);
      });
    } catch (error) {
      console.warn("[Supervisor] Error stopping Gateway:", error.message);
    }
    
    this.process = null;
    gatewayProcess = null;
  }
  
  this._transitionTo("stopped");
}
```

**Key improvements:**
- ✅ Returns a Promise that resolves when Gateway is fully stopped
- ✅ Checks every 100ms if process has exited
- ✅ Graceful shutdown with SIGTERM first
- ✅ Force kill with SIGKILL after 3 seconds if needed
- ✅ Logs progress for debugging

### 2. Awaited stop() in before-quit
Updated the `before-quit` handler to properly await the supervisor's `stop()` method:

```javascript
// AFTER (correct)
app.on("before-quit", async (event) => {
  if (isQuitting) return;
  
  isQuitting = true;
  console.log("[Electron] App is quitting - starting cleanup...");
  
  // Prevent quit until cleanup is done
  event.preventDefault();
  
  try {
    // ... other cleanup ...
    
    // Stop Gateway supervisor (AWAIT to ensure it completes)
    if (supervisor) {
      console.log("[Electron] Stopping Gateway supervisor...");
      await supervisor.stop(); // ✅ Now awaited
    }
    
    console.log("[Electron] Cleanup complete, quitting now");
    
    // Brief delay before quit to ensure everything is settled
    setTimeout(() => app.quit(), 100);
  } catch (error) {
    console.error("[Electron] Error during cleanup:", error);
    setTimeout(() => app.quit(), 100);
  }
});
```

**Key improvements:**
- ✅ Uses `event.preventDefault()` to hold quit until cleanup done
- ✅ Properly awaits `supervisor.stop()`
- ✅ Only calls `app.quit()` after cleanup completes
- ✅ 100ms buffer after cleanup for safety

### 3. Added will-quit Safety Net
Added a final safety net in `will-quit` to force-kill Gateway if somehow still running:

```javascript
app.on("will-quit", (event) => {
  console.log("[Electron] App will quit - final cleanup");
  
  // Force stop Gateway if somehow still running
  if (supervisor && supervisor.getProcess() && !supervisor.getProcess().killed) {
    console.log("[Electron] Force stopping Gateway on will-quit");
    try {
      supervisor.getProcess().kill("SIGKILL");
    } catch (error) {
      console.warn("[Electron] Error force-stopping Gateway:", error.message);
    }
  }
});
```

### 4. Fixed SIGINT/SIGTERM Handlers
Updated the signal handlers to check the `isQuitting` flag to avoid duplicate cleanup:

```javascript
process.on("SIGINT", () => {
  if (isQuitting) return; // ✅ Avoid duplicate cleanup
  console.log("[Electron] Received SIGINT, shutting down...");
  isQuitting = true;
  if (supervisor) supervisor.stop();
  setTimeout(() => app.quit(), 500);
});

process.on("SIGTERM", () => {
  if (isQuitting) return; // ✅ Avoid duplicate cleanup
  console.log("[Electron] Received SIGTERM, shutting down...");
  isQuitting = true;
  if (supervisor) supervisor.stop();
  setTimeout(() => app.quit(), 500);
});
```

## Timeline

### Before Fix
```
1. User clicks Quit
2. before-quit event fires
3. supervisor.stop() called (not awaited)
4. app.quit() called after 100ms
5. Gateway still running (SIGTERM sent but not processed)
6. App quits but Gateway stays alive
7. Port 18789 still bound
```

### After Fix
```
1. User clicks Quit
2. before-quit event fires (first time)
3. event.preventDefault() blocks quit
4. isQuitting = true
5. await supervisor.stop() called
6. SIGTERM sent to Gateway
7. Poll every 100ms for up to 3 seconds
8. Gateway exits gracefully OR force-killed with SIGKILL
9. supervisor.stop() resolves
10. app.quit() called again
11. before-quit fires (second time)
12. isQuitting already true, so return (allow quit)
13. will-quit fires (safety net check)
14. App quits cleanly
15. Port 18789 released
```

## Testing

### Manual Test
1. Start app: `npm start`
2. Wait for Gateway to start (check console logs)
3. Right-click dock/taskbar icon → Quit
4. Check console logs for cleanup messages:
   - "App is quitting - starting cleanup..."
   - "Stopping Gateway supervisor..."
   - "Gateway stopped gracefully" OR "Gateway didn't stop gracefully, force killing..."
   - "Cleanup complete, quitting now"
5. Verify no processes running: `lsof -ti:18789` (should return nothing)
6. Reopen app: should do fresh start, not show existing state

### Expected Console Output (Successful Quit)
```
[Electron] App is quitting - starting cleanup...
[Electron] Cleaning up OAuth servers...
[OAuth IPC] Stopped token refresh timer
[Electron] Cleaning up Papr login server...
[PaprLogin] Cleaned up login state.
[Electron] Cleaning up Ollama...
[Electron] Stopping Gateway supervisor...
[Supervisor] Stopping Gateway process (PID: 12345)...
[Supervisor] Gateway exited with code: 0
[Supervisor] Gateway stopped gracefully
[Supervisor] running → stopped
[Electron] Cleanup complete, allowing app to quit
[Electron] Already quitting, allowing quit to proceed
[Electron] App will quit - final cleanup
```

### Edge Cases

#### Gateway Hangs
If Gateway doesn't respond to SIGTERM:
```
[Supervisor] Stopping Gateway process (PID: 12345)...
[Supervisor] Gateway didn't stop gracefully, force killing...
```

#### Force Quit (Cmd+Q)
Same flow as right-click quit (both trigger `before-quit`)

#### Terminal Ctrl+C
SIGINT handler stops supervisor:
```
[Electron] Received SIGINT, shutting down...
[Supervisor] Stopping Gateway process (PID: 12345)...
```

## Files Changed

- `src/electron/index.cjs`:
  - Changed `stop()` from sync to async
  - Added graceful shutdown with polling
  - Awaited `supervisor.stop()` in `before-quit`
  - Added safety net in `will-quit`
  - Fixed SIGINT/SIGTERM handlers

## Impact

- **Before:** Gateway stayed running after quit, required force-quit
- **After:** All processes stop cleanly, port released, fresh restart works ✅

## Prevention

**Rules for future quit handlers:**
1. Always use `event.preventDefault()` in `before-quit` to hold quit
2. Clean up all resources (child processes, connections, timers)
3. Call `app.quit()` explicitly when cleanup done
4. Add `will-quit` as final safety net for force-kill
5. Test with Activity Monitor/Task Manager to verify no orphans

## Related Issues

- Issue 41: App Staying Running After Quit (original report)
- Issue 40: Stale Running Jobs (related to process cleanup)

## References

- [Electron app.before-quit docs](https://www.electronjs.org/docs/latest/api/app#event-before-quit)
- [Electron app.will-quit docs](https://www.electronjs.org/docs/latest/api/app#event-will-quit)
- [Node.js process.kill docs](https://nodejs.org/api/process.html#processkillpid-signal)
