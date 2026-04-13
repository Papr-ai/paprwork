# Ollama Event Listener Memory Leak Fix

**Added:** 2026-04-12

## Problem

Browser console showed memory leak warning:
```
MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 
11 ollama:download-progress listeners added. 
Use emitter.setMaxListeners() to increase limit
```

## Root Causes

**Two separate issues causing the memory leak:**

### 1. React Hook - Unstable Callback Reference

**File:** `ui/hooks/useOllama.ts`

The `handleProgress` callback was recreated on every render because it was defined inside the `useEffect`. When the cleanup function tried to remove it, it was removing a different function reference than what was added.

```typescript
// ❌ BEFORE - Creates new function on every render
useEffect(() => {
  const handleProgress = (data) => { ... }; // New function every time
  window.electronAPI.ollama.onDownloadProgress(handleProgress);
  
  return () => {
    // This removes a different function than was added!
    window.electronAPI.ollama.removeDownloadProgressListener(handleProgress);
  };
}, [checkStatus]); // Recreates when checkStatus changes
```

### 2. Preload - Wrapper Function Not Tracked

**File:** `src/electron/preload.cjs`

The preload wrapped callbacks in arrow functions but didn't store the wrapper reference, so removal failed:

```javascript
// ❌ BEFORE - Wrapper not tracked
ollama: {
  onDownloadProgress: (callback) => {
    // Creates wrapper but doesn't store it
    ipcRenderer.on("ollama:download-progress", (_event, data) => callback(data));
  },
  removeDownloadProgressListener: (callback) => {
    // Tries to remove original callback, not the wrapper - FAILS
    ipcRenderer.removeListener("ollama:download-progress", callback);
  }
}
```

## Solution

### 1. Fixed React Hook - Stable Callback with useRef

Used `useRef` to create a single stable callback instance that persists across renders:

```typescript
// ✅ AFTER - Single stable callback reference
const handleProgressRef = useRef<(data: ModelInstallProgress) => void>();
const checkStatusRef = useRef<() => Promise<void>>();

if (!handleProgressRef.current) {
  handleProgressRef.current = (data: ModelInstallProgress) => {
    setProgress(data);
    if (data.status === 'complete') {
      setInstalling(null);
      setProgress(null);
      checkStatusRef.current?.(); // Use ref to avoid stale closure
    } else if (data.status === 'error') {
      console.error('[useOllama] Model install error:', data.error);
      setInstalling(null);
    }
  };
}

useEffect(() => {
  // Add listener once with stable reference
  if (window.electronAPI?.ollama && handleProgressRef.current) {
    window.electronAPI.ollama.onDownloadProgress(handleProgressRef.current);
  }

  return () => {
    // Remove the exact same reference
    if (window.electronAPI?.ollama && handleProgressRef.current) {
      window.electronAPI.ollama.removeDownloadProgressListener(handleProgressRef.current);
    }
  };
}, [checkStatus]);
```

**Why this works:**
- `handleProgressRef.current` is created once and never changes
- Same function reference is added and removed
- `checkStatusRef` prevents stale closure issues
- Cleanup properly removes the listener

### 2. Fixed Preload - WeakMap for Wrapper Tracking

Used `WeakMap` to track wrapper functions for proper cleanup:

```javascript
// ✅ AFTER - Wrapper tracked and removed correctly
ollama: (() => {
  // Track wrapper functions for proper cleanup
  const progressListenerMap = new WeakMap();

  return {
    onDownloadProgress: (callback) => {
      // Create wrapper and store mapping
      const wrapper = (_event, data) => callback(data);
      progressListenerMap.set(callback, wrapper);
      ipcRenderer.on("ollama:download-progress", wrapper);
    },
    removeDownloadProgressListener: (callback) => {
      // Remove using the stored wrapper
      const wrapper = progressListenerMap.get(callback);
      if (wrapper) {
        ipcRenderer.removeListener("ollama:download-progress", wrapper);
        progressListenerMap.delete(callback);
      }
    },
  };
})(),
```

**Why this works:**
- `WeakMap` maps original callback → wrapper function
- When removing, we look up the wrapper and remove that
- `WeakMap` allows garbage collection when callbacks are no longer referenced
- IIFE pattern creates closure for `progressListenerMap`

## Files Changed

- `ui/hooks/useOllama.ts` - Added `useRef` for stable callback, fixed cleanup
- `src/electron/preload.cjs` - Added `WeakMap` for wrapper tracking

## Impact

- **Before:** 11+ listeners accumulated, memory leak warning in console
- **After:** Single listener properly added and removed, no warnings ✅
- **Memory:** WeakMap allows garbage collection, no memory retention
- **Behavior:** Download progress still works correctly

## Testing

1. Start app
2. Select Ollama model (trigger download)
3. Check browser console - should see NO memory leak warnings
4. Reload page multiple times - listeners should be cleaned up each time
5. Download should work correctly with progress updates

## Pattern for Future IPC Events

**Always track wrapper functions when using IPC events:**

```javascript
someNamespace: (() => {
  const listenerMap = new WeakMap();
  
  return {
    onEvent: (callback) => {
      const wrapper = (_event, data) => callback(data);
      listenerMap.set(callback, wrapper);
      ipcRenderer.on("event:name", wrapper);
    },
    removeEventListener: (callback) => {
      const wrapper = listenerMap.get(callback);
      if (wrapper) {
        ipcRenderer.removeListener("event:name", wrapper);
        listenerMap.delete(callback);
      }
    },
  };
})(),
```

## Related Issues

- Similar pattern can be applied to other IPC events in preload
- All event listeners in React hooks should use stable references via `useRef` or `useCallback` with empty deps

## Prevention

1. **React hooks:** Use `useRef` for callbacks that need stable identity
2. **Preload IPC:** Always track wrapper functions with `WeakMap`
3. **Testing:** Check browser console for `MaxListenersExceededWarning`
4. **Code review:** Verify cleanup functions remove the exact same reference that was added
