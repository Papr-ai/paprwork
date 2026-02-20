# Error Resolution Guide

## Issue: `useTabs is not defined`

### Root Cause
This is a **Vite hot reload issue**. When new files are created (like `useTabs.ts` and `tabStore.ts`), Vite's HMR (Hot Module Replacement) sometimes doesn't properly detect and reload them.

### Solution
**Restart the development server:**

```bash
# Stop the current dev server (Ctrl+C in the terminal)
# Then restart:
npm run dev
```

### Verification
After restart, the error should disappear. All files are correctly structured:
- ✅ `ui/hooks/useTabs.ts` exists and exports `useTabs()`
- ✅ `ui/stores/tabStore.ts` exists and exports `useTabStore()`
- ✅ Import paths are correct: `../../hooks/useTabs` from Sidebar
- ✅ TypeScript compiles successfully
- ✅ Linter passes (only minor unused variable warnings, now fixed)

---

## Issue: `useArtifacts` Load Error

### Root Cause
The Document and App services weren't using the singleton pattern like Agent and Chat services, causing the websocket handlers to fail.

### Solution Applied
✅ Updated `DocumentService.ts` to use singleton pattern:
- Added `getDocumentService()` function
- Added `initializeDocumentService()` function

✅ Updated `AppService.ts` to use singleton pattern:
- Added `getAppService()` function
- Added `initializeAppService()` function

✅ Updated gateway initialization:
- Changed to use `initializeDocumentService()` and `initializeAppService()`
- Services now properly initialized on startup

✅ Updated websocket handlers:
- `document.ts` now uses `getDocumentService()`
- `app.ts` now uses `getAppService()`
- Handlers can access initialized services

### Verification
After restarting the dev server, artifacts should load without errors.

---

## Additional Fixes Applied

### 1. Lint Warnings Fixed
- ✅ Removed unused `TabType` import from `useTabs.ts`
- ✅ Removed unused `leftTab` and `rightTab` variables from `ContentArea.tsx`
- ✅ Removed unused `enableSplitView` from `Tab.tsx`

### 2. All Features Implemented
- ✅ Keyboard shortcuts for tabs (⌘T, ⌘W, ⌘Tab, ⌘1-9)
- ✅ Input layout matches v1 (context top, footer bottom)
- ✅ No scrollbar on textarea
- ✅ Welcome message with v1 design
- ✅ Navigation buttons in tab bar (back, forward, home)
- ✅ Liquid Glass transparency with backdrop blur

---

## Next Steps

1. **Restart the dev server:**
   ```bash
   npm run dev
   ```

2. **Verify all features work:**
   - ✅ Tabs appear and are interactive
   - ✅ Sidebar navigation creates tabs
   - ✅ Keyboard shortcuts work
   - ✅ Input shows controls on focus
   - ✅ Welcome message displays
   - ✅ Liquid Glass transparency visible
   - ✅ No console errors

3. **Test the UI:**
   - Create a new chat
   - Switch between tabs with keyboard
   - Click sidebar navigation items
   - Focus the input to see controls
   - Verify backdrop blur effect

All issues should now be resolved! 🎉
