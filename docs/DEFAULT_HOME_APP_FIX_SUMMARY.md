# Default Home App Installation - Fix Summary

## Issue
Fresh installations of Paprwork showed "Agent Lounge (Coming Soon)" placeholder instead of the bundled home dashboard.

## Root Cause
The `installDefaultApps()` method was copying app files to `$PAPR_HOME/apps/{id}/` but **not registering them** in `$PAPR_HOME/data/apps.json`. This meant:
- Files existed on disk ✅
- Not in apps registry ❌
- `HomeRedirect` component couldn't find the app ❌
- Showed placeholder instead ❌

## Solution

### 1. Fixed `installDefaultApps()` Method
**File:** `src/gateway/services/AppService.ts`

**Changes:**
- ✅ Read `metadata.json` from bundled default apps
- ✅ Create proper `MiniApp` objects with all required fields
- ✅ Add apps to `this.apps` Map
- ✅ Call `saveApps()` to persist to `apps.json`
- ✅ Resolve icons automatically from app directory
- ✅ Handle both fresh installs and existing files

### 2. Added ESM Compatibility
**Issue:** `__dirname` not available in ES modules

**Fix:**
```typescript
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```

### 3. Fixed Resource Path
**Issue:** Wrong relative path to resources

**Before:** `../resources/` (goes to `dist/gateway/resources/` - wrong!)
**After:** `../../resources/` (goes to `dist/resources/` - correct!)

## Testing

### Automated Test
**Command:** `npm run test:default-app`

**Coverage:**
- ✅ Fresh environment (empty registry)
- ✅ App installation via `initialize()`
- ✅ Registry verification
- ✅ Filesystem verification
- ✅ Metadata and icon verification
- ✅ Idempotency (no duplicates)

**Result:** All tests passing ✅

### Manual Verification
**Command:** `node scripts/verify-home-app.mjs`

**Current Status:**
```
✅ Home app found in registry
   Title: "Home"
   Has icon: Yes
✅ Home app directory exists
   Files: 27 total
   index.html: Yes
✅ Settings configured
   defaultHomeAppId: bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c
   Matches home app: Yes
```

## Impact

### Before Fix
- Fresh installations → "Agent Lounge (Coming Soon)" placeholder
- Home dashboard inaccessible
- Confusing first-run experience
- Users couldn't access default dashboard

### After Fix
- Fresh installations → Home dashboard opens automatically
- Professional first-run experience
- All bundled apps installed and registered
- HomeRedirect works correctly

## Files Changed

1. **`src/gateway/services/AppService.ts`**
   - Fixed `installDefaultApps()` to register apps
   - Added ESM compatibility (`import.meta.url`)
   - Fixed resource path (`../../resources/`)

2. **`src/core/telemetry/properties.ts`**
   - Fixed TypeScript unused parameter error

3. **`scripts/test-default-app-install.mjs`** (NEW)
   - Automated test for default app installation

4. **`scripts/verify-home-app.mjs`** (NEW)
   - Quick verification script for production

5. **`package.json`**
   - Added `test:default-app` script

6. **`docs/DEFAULT_HOME_APP_INSTALLATION_FIX.md`** (NEW)
   - Complete technical documentation

7. **`CLAUDE.md`**
   - Added Issue 42 documentation

## Related Issues

- **Enhancement 26:** Default Home App Configuration (settings)
- **Enhancement 27:** Smart Default Provider & Bundled Home Dashboard
- **Issue 35:** Default Home App Not Bundled (electron-builder.json)

## Next Steps for Fresh Install Testing

1. Stop the app (Cmd+Q)
2. Backup your apps: `mv $PAPR_HOME/data/apps.json $PAPR_HOME/data/apps.json.backup`
3. Create empty registry: `echo "[]" > $PAPR_HOME/data/apps.json`
4. Remove home app: `rm -rf $PAPR_HOME/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c`
5. Start the app: `npm start`
6. Verify: `node scripts/verify-home-app.mjs`
7. Check UI: Click home button → should open dashboard
8. Restore backup: `mv $PAPR_HOME/data/apps.json.backup $PAPR_HOME/data/apps.json`

## Prevention

- Always test fresh installations (empty registry)
- Use automated tests before releases
- Verify bundled resources are accessible
- Check both registry AND filesystem
- Remember ESM differences (`import.meta.url`)

---

**Status:** ✅ Fixed and tested
**Date:** 2026-04-07
**Tested By:** Automated test + manual verification
