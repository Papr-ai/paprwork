# Mini-App Auto-Reload Implementation

**Date:** 2026-03-17

## Problem

When agents edited mini-app files using bash commands (like `sed`), the mini-app iframe in the UI didn't automatically reload to show the changes. The agent would make changes, but users had to manually refresh the tab to see updates.

## Root Cause

The `AppService` only broadcasted `app:file-changed` events when files were modified via the WebSocket API (`app:write-file`). When agents used bash tools to directly modify files on disk, these filesystem changes bypassed the WebSocket layer, so no broadcast was sent.

## Solution

Added filesystem watching to `AppService` using Node.js's native `fs.watch` API. Now the service automatically detects when any file in an app directory changes (regardless of how it was modified) and broadcasts the change to all connected clients.

## Implementation Details

### 1. File System Watchers

Added recursive file watching for all app directories:

```typescript
private watchers: Map<string, FSWatcher>;
private debounceTimers: Map<string, NodeJS.Timeout>;

private async watchApp(appId: string): Promise<void> {
  const watcher = watch(
    appPath,
    { recursive: true },
    (eventType, filename) => {
      // Ignore version history, data sources, and hidden files
      if (
        filename.startsWith(".versions") ||
        filename === "data-sources.json" ||
        filename.startsWith(".")
      ) {
        return;
      }
      
      // Debounce file changes (200ms)
      this.handleFileChange(appId, filename);
    }
  );
}
```

### 2. Debouncing

File system events can fire multiple times for a single edit (especially on macOS). Implemented 200ms debouncing to prevent rapid-fire reload events:

```typescript
const debounceKey = `${appId}:${filename}`;

if (this.debounceTimers.has(debounceKey)) {
  clearTimeout(this.debounceTimers.get(debounceKey)!);
}

const timer = setTimeout(() => {
  this.debounceTimers.delete(debounceKey);
  this.handleFileChange(appId, filename);
}, 200);

this.debounceTimers.set(debounceKey, timer);
```

### 3. Lifecycle Management

**Initialization:**
- Watchers start automatically when `AppService.initialize()` is called
- Watches all existing app directories on startup

**Create App:**
- New watchers start automatically when apps are created via `createApp()`

**Delete App:**
- Watchers are stopped and cleaned up when apps are deleted via `deleteApp()`

**Shutdown:**
- All watchers are properly cleaned up via `cleanup()` method called in gateway shutdown handler

### 4. Filtered Events

The watcher ignores certain files to prevent unnecessary reloads:
- `.versions/` directory (file version history)
- `data-sources.json` (SQLite data source links)
- Any files starting with `.` (hidden files)

## Frontend Integration

The frontend was already set up to listen for `app:file-changed` events via `useApp` hook:

```typescript
useEffect(() => {
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent;
    const data = customEvent.detail;

    if (data.type === "app:file-changed" && data.data?.appId === appId) {
      triggerReload(); // Increments reloadKey, forcing iframe reload
    }
  };

  window.addEventListener("gateway-broadcast", handler);
  return () => window.removeEventListener("gateway-broadcast", handler);
}, [appId, triggerReload]);
```

The `reloadKey` is used as the iframe's `key` prop, so incrementing it forces React to unmount and remount the iframe, triggering a full reload.

## Benefits

1. **Works with Any Edit Method:** Agents can use `sed`, `echo`, direct file writes, or the WebSocket API - all trigger reloads
2. **Real-time Updates:** Changes appear instantly in the UI without manual refresh
3. **Performance:** Debouncing prevents excessive reloads during rapid file changes
4. **Clean Shutdown:** Proper cleanup prevents resource leaks
5. **Selective Watching:** Ignores metadata files to prevent reload loops

## Testing

Test scenarios:
1. Agent uses `sed` to edit `index.html` → iframe reloads automatically ✓
2. Agent uses `echo` to write `style.css` → iframe reloads automatically ✓
3. Agent creates new file via bash → iframe reloads automatically ✓
4. User edits file via WebSocket API → iframe reloads automatically ✓
5. Multiple rapid edits → debounced to single reload ✓
6. App deletion → watcher cleaned up properly ✓

## Files Changed

- `src/gateway/services/AppService.ts` - Added watchers, debouncing, lifecycle management
- `src/gateway/index.ts` - Added AppService cleanup to shutdown handler
- `docs/MINI_APP_AUTO_RELOAD.md` - This documentation

## Future Enhancements

Potential improvements:
1. **Configurable Debounce:** Allow users to adjust debounce timing
2. **Smart Reloading:** Only reload if HTML/CSS/JS changes (not JSON data files)
3. **Partial Updates:** Hot module replacement instead of full iframe reload
4. **Watch Stats:** Log watcher performance metrics for debugging

## References

- Node.js `fs.watch` API: https://nodejs.org/api/fs.html#fswatchfilename-options-listener
- Related: `useApp` hook in `ui/hooks/useApp.ts`
- Related: WebSocket broadcast in `src/gateway/websocket/index.ts`
