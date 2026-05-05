# Zombie Process Fix

## Problem

After quitting the Paprwork app (even with Ctrl-C), orphaned Gateway processes remained running and occupied port 18789. This caused:

1. **Request timeout errors** on app restart (Gateway couldn't bind to the port)
2. **Multiple zombie processes** accumulating over time
3. **Manual cleanup required** to kill processes before restarting

Example errors:
```
[Gateway] Uncaught exception: Error: listen EADDRINUSE: address already in use 0.0.0.0:18789
[Renderer error] [App] Failed to load UI preferences: Error: Request timeout
[Renderer error] Failed to load chats: Error: Request timeout
```

## Root Causes

### 1. Multiple PIDs Not Handled Properly

**Location:** `src/electron/index.cjs:726`

When `lsof -ti:18789` found multiple processes, it returned:
```
57131
72594
```

But the cleanup code treated this as a single PID string:
```javascript
const pid = execSync(`lsof -ti:${this.port}`, { encoding: "utf8" }).trim();
execSync(`kill -9 ${pid}`);  // Tried to kill "57131\n72594" - FAILS!
```

The `kill` command failed silently, leaving orphans alive.

### 2. Gateway Didn't Exit on EADDRINUSE

**Location:** `src/gateway/index.ts:1196`

When the Gateway encountered `EADDRINUSE`, it logged an uncaught exception but **didn't exit**:
```javascript
process.on("uncaughtException", (error) => {
  console.error("[Gateway] Uncaught exception:", error);
  // No process.exit() - zombie process continued running!
});
```

This created zombie processes that couldn't serve requests but held the port.

## Solutions Applied

### Fix 1: Handle Multiple PIDs in Orphan Cleanup

**File:** `src/electron/index.cjs`

```javascript
// OLD (broken)
const pid = execSync(`lsof -ti:${this.port}`, { encoding: "utf8" }).trim();
execSync(`kill -9 ${pid}`);

// NEW (fixed)
const output = execSync(`lsof -ti:${this.port}`, { encoding: "utf8" }).trim();
const pids = output.split('\n').filter(p => p.trim());
console.log(`[Supervisor] Found ${pids.length} orphaned process(es): ${pids.join(', ')}`);

for (const pid of pids) {
  try {
    execSync(`kill -9 ${pid.trim()}`);
    console.log(`[Supervisor] Killed orphaned process ${pid}`);
  } catch (killErr) {
    console.warn(`[Supervisor] Failed to kill PID ${pid}:`, killErr.message);
  }
}
```

**Result:** All orphaned processes are now properly killed on startup.

### Fix 2: Exit Gateway on EADDRINUSE

**File:** `src/gateway/index.ts`

```javascript
// OLD (broken)
process.on("uncaughtException", (error) => {
  console.error("[Gateway] Uncaught exception:", error);
  // No exit!
});

// NEW (fixed)
process.on("uncaughtException", (error) => {
  console.error("[Gateway] Uncaught exception:", error);
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error("[Gateway] Fatal error: Port already in use. Exiting.");
    process.exit(1);  // Prevent zombie process
  }
});
```

**Result:** Gateway now exits cleanly when port is in use, allowing supervisor to clean up.

## Testing

1. **Before Fix:**
   ```bash
   # Start app, quit, check processes
   lsof -ti:18789
   # Output: Multiple PIDs still running
   ```

2. **After Fix:**
   ```bash
   # Start app, quit, check processes
   lsof -ti:18789
   # Output: (empty - all cleaned up)
   ```

## Additional Benefits

- **Better logging:** Now shows exactly how many orphans were found and killed
- **Error resilience:** Individual PID kill failures don't stop cleanup of others
- **Faster recovery:** App restarts work immediately without manual intervention

## Related Files

- `src/electron/index.cjs` - Supervisor cleanup logic
- `src/gateway/index.ts` - Gateway error handling

## Status

✅ **FIXED** - Build successful, no linter errors
