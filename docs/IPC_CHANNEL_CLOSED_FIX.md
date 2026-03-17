# IPC Channel Closed Fix

**Issue Date:** 2026-03-16
**Status:** ✅ FIXED

## Problem

Gateway process crashes with `ERR_IPC_CHANNEL_CLOSED` when bash tool tries to access custom keys during agent execution.

### Error Trace

```
[Gateway] Uncaught exception: Error [ERR_IPC_CHANNEL_CLOSED]: Channel closed
    at target.send (node:internal/child_process:753:16)
    at CustomKeysService.listKeys (CustomKeysService.js:53:25)
    at executeBashCommand (bash.js:134:46)
```

### Root Cause

`CustomKeysService` was calling `process.send()` without checking if the IPC channel was still open. This happens when:

1. Main process is shutting down
2. Gateway process is being terminated
3. Communication pipe was broken unexpectedly

The service would throw an unhandled exception instead of gracefully falling back to dev mode.

## Solution

Added graceful IPC channel handling with three layers:

### 1. Connection Check

```typescript
private checkIpcAvailable(): boolean {
  if (!process.send || !process.connected) {
    return false;
  }
  return true;
}
```

### 2. Safe Send Wrapper

```typescript
private safeSend(message: any): boolean {
  if (!this.checkIpcAvailable()) {
    return false;
  }
  try {
    process.send!(message);
    return true;
  } catch (error) {
    if (error instanceof Error && 
        'code' in error && 
        error.code === 'ERR_IPC_CHANNEL_CLOSED') {
      console.warn('[CustomKeysService] IPC channel closed');
      this.ipcAvailable = false;
    }
    return false;
  }
}
```

### 3. Fallback Handling

All IPC methods now:
- Check `this.ipcAvailable` before attempting communication
- Use `safeSend()` instead of direct `process.send()`
- Fall back to dev mode behavior (env vars, empty arrays) if channel closed
- Log warnings instead of throwing exceptions

## Impact

### Before Fix
- ❌ Gateway crashes with unhandled exception
- ❌ Agent execution stops
- ❌ User sees error in chat
- ❌ Must restart app to recover

### After Fix
- ✅ Gateway continues running
- ✅ Bash tool falls back to env vars for custom keys
- ✅ Agent execution continues smoothly
- ✅ Only warning logged, no crash

## Testing

The fix handles:
1. ✅ IPC channel closed during operation
2. ✅ Channel never opened (dev mode)
3. ✅ Channel closed between calls (state tracking)
4. ✅ Multiple concurrent requests after closure

## Files Changed

- `src/gateway/services/CustomKeysService.ts` - Added graceful IPC handling
  - Added `ipcAvailable` state tracking
  - Added `checkIpcAvailable()` method
  - Added `safeSend()` wrapper with error handling
  - Updated all IPC methods to use safe sending

## Prevention

To avoid similar issues in the future:

1. **Always check `process.connected`** before calling `process.send()`
2. **Wrap IPC calls in try-catch** for `ERR_IPC_CHANNEL_CLOSED`
3. **Provide graceful fallbacks** for when IPC is unavailable
4. **Log warnings** instead of throwing exceptions when possible
5. **Track IPC state** to avoid repeated failed attempts

## Related Issues

This is similar to Issue #6 (Electron Module System) where we had to ensure proper IPC setup. The difference is:

- Issue #6: IPC not set up correctly (module system problem)
- This issue: IPC was working but closed during operation (lifecycle problem)

## Future Improvements

Consider adding:
- Reconnection logic if IPC channel closes unexpectedly
- Health check ping/pong between main and gateway
- Automatic gateway restart if IPC fails
- Better lifecycle coordination between processes
