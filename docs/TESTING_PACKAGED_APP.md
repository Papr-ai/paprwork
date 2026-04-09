# Testing the Packaged Mac App

## Quick Issue: App Opens and Immediately Closes

**Cause:** Single instance lock - only one instance of Papr Work can run at a time.

**Solution:** Stop any running dev instances before testing the packaged app.

### Steps to Test Packaged App

1. **Stop dev version** (if running):
   ```bash
   # In the terminal running npm start, press:
   Ctrl+C
   
   # Or kill all Electron processes:
   pkill -f "Electron.*Papr Work"
   ```

2. **Launch packaged app**:
   ```bash
   # Via Finder:
   open "release/mac-arm64/Papr Work.app"
   
   # Or via terminal (to see logs):
   "release/mac-arm64/Papr Work.app/Contents/MacOS/Papr Work"
   ```

3. **App should now launch successfully** without closing immediately

### Why This Happens

The single instance lock (added in Issue #24 for Windows support) prevents multiple instances from running:

```javascript
// src/electron/index.cjs
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[Electron] Another instance is already running, quitting');
  app.quit();
}
```

This is **correct behavior** - it ensures:
- Only one Papr Work instance runs at a time
- Deep links go to the existing instance (not a new one)
- Consistent behavior across macOS, Windows, and Linux

### Checking for Running Instances

```bash
# Check if Papr Work is running
ps aux | grep -i "papr work" | grep -v grep

# Kill all instances
pkill -f "Electron.*Papr Work"
```

### Development vs. Production

- **Dev mode** (`npm start`): Uses Electron from `node_modules/electron/dist/Electron.app`
- **Packaged app**: Self-contained app bundle in `release/mac-arm64/`
- **Both count as instances** of "Papr Work" due to `app.setName("Papr Work")`

### Expected Behavior

✅ **Correct:**
- Dev running → Try to launch packaged app → Immediately closes with "Another instance is already running"
- No instances running → Launch packaged app → Opens successfully

❌ **Incorrect:**
- No instances running → Launch packaged app → Opens and immediately closes
  - This would indicate a crash/error (check Console.app logs)
