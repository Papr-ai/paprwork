# Default Home App Installation Fix

**Issue:** Fresh installations showed "Agent Lounge (Coming Soon)" placeholder instead of the bundled home dashboard.

**Date:** 2026-04-07

## Problem

When users installed Paprwork for the first time, the home dashboard app:
- ✅ **Files were copied** to `~/Papr/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c/`
- ❌ **Not registered** in `~/Papr/data/apps.json` (apps index)
- ❌ **HomeRedirect failed** because `app:list` returned empty array
- ❌ **Showed placeholder** instead of dashboard

## Root Causes

1. **Missing Registry Logic**: `installDefaultApps()` only copied files but didn't add apps to the registry
2. **Wrong Path**: Used `__dirname` without ESM compatibility (`import.meta.url` needed)
3. **Incorrect Relative Path**: Used `../resources/` instead of `../../resources/` from `dist/gateway/services/`

## Solution

Enhanced `AppService.installDefaultApps()` to:

1. **Check both registry and filesystem**
   - If app exists in registry → skip
   - If files exist but not registered → register them
   - If neither exist → install files + register

2. **Read metadata.json**
   - Use bundled metadata for app details (title, description, etc.)
   - Fallback to defaults if metadata missing

3. **Register apps properly**
   - Create `MiniApp` object with all required fields
   - Add to `this.apps` Map
   - Call `saveApps()` to persist to `apps.json`

4. **Resolve icons automatically**
   - Check metadata.icon first
   - Fall back to `resolveIconFromAppDir()` (logo.svg, icon.svg, favicon.svg)

5. **ESM Compatibility**
   - Added `fileURLToPath` import
   - Defined `__dirname` from `import.meta.url`
   - Fixed relative path: `../../resources/default-apps/` (up 2 levels from `dist/gateway/services/`)

## Code Changes

**File:** `src/gateway/services/AppService.ts`

```typescript
// Added ESM compatibility
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fixed installDefaultApps()
private async installDefaultApps(): Promise<void> {
  try {
    // Fixed path: up 2 levels from dist/gateway/services/
    const defaultAppsDir = path.join(__dirname, "..", "..", "resources", "default-apps");
    
    for (const appDirName of defaultAppDirs) {
      // Check if already registered
      if (this.apps.has(appId)) {
        console.log(`[AppService] Default app already in registry: ${appId}`);
        continue;
      }
      
      // Copy files if needed
      if (needsInstall) {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.cp(sourceDir, targetDir, { recursive: true });
      }
      
      // Read metadata.json
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8"));
      
      // Resolve icon
      let icon = metadata.icon;
      if (!icon) {
        icon = await this.resolveIconFromAppDir(targetDir);
      }
      
      // Create app entry
      const app: MiniApp = {
        id: appId,
        title: metadata.title || appDirName,
        description: metadata.description || "Default app",
        type: "app",
        createdAt: metadata.createdAt || now,
        updatedAt: now,
        favorite: metadata.favorite || false,
        ...(icon ? { icon } : {}),
      };
      
      // Register in index
      this.apps.set(appId, app);
      installedCount++;
    }
    
    // Save index
    if (installedCount > 0) {
      await this.saveApps();
    }
  }
}
```

## Testing

Created automated test script: `scripts/test-default-app-install.mjs`

**Run:** `npm run test:default-app`

**Test Coverage:**
1. ✅ Creates fresh test environment (empty registry + no files)
2. ✅ Calls `AppService.initialize()` to trigger installation
3. ✅ Verifies app registered in `apps.json` with correct metadata
4. ✅ Verifies app files copied to disk
5. ✅ Verifies icon resolved correctly
6. ✅ Verifies idempotency (no duplicates on second init)

**Test Results:**
```
✅ Home app registered: "Home"
✅ All required fields present
✅ Title correct: "Home"
✅ Icon present and valid (SVG)
✅ Home app directory created
✅ index.html exists
✅ 10 app files installed
✅ No duplicates created (idempotent)
```

## Impact

**Before:**
- Fresh installations → "Agent Lounge (Coming Soon)" placeholder
- Users couldn't access home dashboard
- Confusing first-run experience

**After:**
- Fresh installations → Home dashboard opens automatically
- All default apps installed and registered
- Professional first-run experience
- HomeRedirect works correctly

## Files Changed

- `src/gateway/services/AppService.ts` - Fixed `installDefaultApps()` + ESM compatibility
- `src/core/telemetry/properties.ts` - Fixed unused parameter TypeScript error
- `scripts/test-default-app-install.mjs` - NEW: Automated test
- `package.json` - Added `test:default-app` script

## Related

- Enhancement 26: Default Home App Configuration (settings integration)
- Enhancement 27: Smart Default Provider (complementary feature)
- Issue 35: Default Home App Not Bundled (original electron-builder fix)

## Prevention

1. Always test fresh installations (empty `~/Papr/data/apps.json`)
2. Verify bundled resources are accessible via `__dirname` paths
3. Check both registry AND filesystem for app existence
4. Use automated tests before releasing new default apps
5. Remember ESM module differences (`import.meta.url` instead of `__dirname`)

## Future Improvements

1. Add more default apps (templates, examples)
2. Version default apps (allow updates)
3. User preference: disable default app installation
4. Better error messages if installation fails
5. Support for default app updates (overwrite existing files)
