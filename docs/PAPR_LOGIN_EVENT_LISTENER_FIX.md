# Papr Login Event Listener Memory Leak Fix

**Date:** 2026-04-12  
**Issue:** MaxListenersExceededWarning for `papr:login-success`, `papr:namespace-changed`, `papr:organization-changed`

## Problem

Same pattern as Ollama memory leak (Issue 54):
- Event listeners added on every render without cleanup
- Callbacks recreated on each render → cleanup removed different reference than was added
- Resulted in 11+ duplicate listeners accumulating

## Root Causes

### 1. Preload (preload.cjs)
- Wrapped callbacks in arrow functions: `(_event, data) => callback(data)`
- But didn't track wrapper → removal tried to remove original callback (which was never added)
- Same as Ollama issue

### 2. React Component (PaprLoginSection.tsx)
- `useEffect` with `[onApiKeyReceived]` dependency → re-ran when prop changed
- No cleanup for IPC listeners (only DOM listeners)
- Callbacks recreated each render

## Solution

Applied same pattern as Ollama fix:

### 1. Preload - WeakMap Wrapper Tracking
```javascript
papr: (() => {
  const loginSuccessListenerMap = new WeakMap();
  const namespaceChangedListenerMap = new WeakMap();
  const organizationChangedListenerMap = new WeakMap();

  return {
    onLoginSuccess: (callback) => {
      const wrapper = (_event, data) => callback(data);
      loginSuccessListenerMap.set(callback, wrapper); // Track wrapper
      ipcRenderer.on("papr:login-success", wrapper);
    },
    removeLoginSuccessListener: (callback) => {
      const wrapper = loginSuccessListenerMap.get(callback);
      if (wrapper) {
        ipcRenderer.removeListener("papr:login-success", wrapper);
        loginSuccessListenerMap.delete(callback);
      }
    },
    // Same for namespace and organization...
  };
})(),
```

### 2. React Component - Stable Refs + Cleanup
```typescript
useEffect(() => {
  // Create stable callback refs (won't change between renders)
  const handleLoginSuccessRef = useRef((data) => {
    setIsLoggedIn(true);
    setUserEmail(data.email);
    // ...
  }).current;

  // Register listeners
  window.electronAPI.papr.onLoginSuccess(handleLoginSuccessRef);
  
  // Cleanup on unmount
  return () => {
    window.electronAPI.papr.removeLoginSuccessListener(handleLoginSuccessRef);
  };
}, []); // Empty deps - stable refs, cleanup on unmount
```

## Files Changed

1. **src/electron/preload.cjs**
   - Wrapped `papr` object in IIFE with WeakMaps
   - Added 4 removal methods: `removeLoginSuccessListener`, `removeLogoutSuccessListener`, `removeNamespaceChangedListener`, `removeOrganizationChangedListener`
   - Track wrappers for proper cleanup

2. **ui/types/electron.d.ts**
   - Added TypeScript definitions for 4 removal methods

3. **ui/components/Settings/PaprLoginSection.tsx**
   - Added `useRef` import
   - Created stable callback refs with `useRef().current`
   - Added cleanup to remove IPC listeners
   - Changed deps from `[onApiKeyReceived]` to `[]` (stable refs)

## Testing

**Before:**
```
MaxListenersExceededWarning: 11 papr:login-success listeners
MaxListenersExceededWarning: 11 papr:namespace-changed listeners  
MaxListenersExceededWarning: 11 papr:organization-changed listeners
```

**After:**
```
# No warnings - single listener properly cleaned up ✅
```

**Verification:**
1. Open Settings → AI Models (mounts PaprLoginSection)
2. Switch to Profile tab (unmounts)
3. Switch back to AI Models (remounts)
4. Repeat 5-10 times
5. Check console → No MaxListenersExceededWarning

## Pattern

**Use this pattern for ALL IPC event listeners:**

1. **Preload:** Use WeakMap to track wrappers + provide removal methods
2. **React:** Use `useRef` for stable callbacks + cleanup in `useEffect`
3. **Empty dependency array** when using stable refs

## Related

- **Issue 54:** Ollama Event Listener Memory Leak (same pattern, fixed same way)
- **Enhancement 41:** Ollama download progress tracking (first occurrence of this pattern)

## Prevention

- Always provide removal methods for IPC listeners in preload
- Always use `useRef` for callbacks passed to IPC listeners
- Always cleanup IPC listeners in `useEffect` return
- Check console for MaxListenersExceededWarning regularly
