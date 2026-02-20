# Blank Screen Debugging Guide

**Status:** Gateway running ✅, UI files served ✅, but blank screen ❌

---

## Quick Diagnosis

The app is running but React isn't rendering. Let's check for errors:

### Step 1: Open DevTools (Already Open)
The logs show: `mainWindow.webContents.openDevTools();`
So DevTools should be visible on the right side.

### Step 2: Check Console Tab
Look in the **Console** tab of DevTools for errors. Common errors:

**If you see:** `window.electronAPI is undefined`
**Fix:** Preload script issue → See Fix #1 below

**If you see:** `Cannot read property 'customKeys' of undefined`
**Fix:** electronAPI not exposed → See Fix #2 below

**If you see:** `WebSocket connection failed`
**Fix:** WebSocket issue → See Fix #3 below

**If you see:** Nothing (no errors)
**Fix:** React mounting issue → See Fix #4 below

---

## Common Fixes

### Fix #1: Preload Script Not Loading

**Check:**
```bash
ls -la src/electron/preload.cjs
ls -la dist/electron/preload.cjs
```

**If missing, rebuild:**
```bash
npm run build
npm start
```

---

### Fix #2: electronAPI Not Exposed

**Check in DevTools Console:**
```javascript
window.electronAPI
// Should show: { customKeys: {...}, permissions: {...}, env: {...} }
```

**If undefined:**
1. Check `src/electron/preload.cjs` has `contextBridge.exposeInMainWorld`
2. Rebuild: `npm run build && npm start`

---

### Fix #3: WebSocket Connection Issue

**Check in DevTools Console:**
```javascript
// Look for: WebSocket connection to 'ws://localhost:18789' failed
```

**Fix:**
- Gateway is already running (we verified)
- Check Network tab for failed WebSocket connection
- Try restarting: `Ctrl+C` then `npm start`

---

### Fix #4: React Not Mounting

**Check in DevTools Console:**
```javascript
document.getElementById('root')
// Should return: <div id="root"></div>

document.getElementById('root').innerHTML
// Should have React content or empty string
```

**If root exists but empty:**
1. Check for React errors in Console
2. Check if assets loaded in Network tab
3. Try: `npm run build && npm start`

---

## Manual Checks You Can Do Now

### In DevTools Console, type:

```javascript
// 1. Check if electronAPI exists
console.log('electronAPI:', window.electronAPI);

// 2. Check if root element exists
console.log('root:', document.getElementById('root'));

// 3. Check if React loaded
console.log('React:', window.React);

// 4. Check WebSocket
console.log('Check Network tab for ws://localhost:18789 connection');
```

---

## Most Likely Issues (Based on Recent Changes)

### Issue #1: Preload Script
We just added `permissions` to `preload.cjs`. If there's a syntax error:

**Check:** `src/electron/preload.cjs` line 45-72 (permissions section)
**Symptom:** `window.electronAPI` is undefined
**Fix:** Check console for syntax errors

### Issue #2: UI Needs Rebuild
We changed TypeScript files. UI might need rebuild:

```bash
npm run build:ui
npm start
```

### Issue #3: Missing Permission Hook
We added `useKeyPermissions` hook. If it crashes on mount:

**Check:** Console for errors about hooks
**File:** `ui/hooks/useKeyPermissions.ts`
**Fix:** Check if `window.electronAPI.permissions` exists

---

## Emergency Fix (Nuclear Option)

If nothing else works:

```bash
# 1. Kill everything
pkill -f electron
pkill -f node

# 2. Clean build
rm -rf dist/
npm run build

# 3. Start fresh
npm start
```

---

## What To Tell Me

Please check DevTools Console and tell me:

1. **Any red errors?** (Copy the full error message)
2. **What does `window.electronAPI` show?** (Type it in console)
3. **Network tab:** Any failed requests? (especially .js files or WebSocket)
4. **Elements tab:** Does `<div id="root">` have any child elements?

This will help me pinpoint the exact issue!

---

## Expected Console Output (When Working)

You should see something like:
```
[App] ========== RENDER START ==========
[App] Current render state:
[App]   - tabs.length: 0
[App]   - activeTabId: null
[useKeyPermissions] Setting up permission request listener
[WebSocket] Connecting to ws://localhost:18789
[WebSocket] Connected ✓
```

If you don't see this, there's a JavaScript error preventing React from mounting.
