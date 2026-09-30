# Default Home App Not Bundled in Packaged Builds Fix

**Issue Date:** 2026-04-06  
**Status:** ✅ FIXED

## Problem

On Windows (and all packaged builds), clicking the home button showed the placeholder "Agent Lounge (Coming Soon)" instead of the Weekly War Room dashboard app. Users expected to see the home dashboard that was configured as the default home app.

## Root Cause

The home dashboard app is stored in `src/resources/default-apps/home-dashboard/` but was not included in `electron-builder.json`'s `files` array. This meant:

1. **Development mode:** Works fine (files on disk, AppService reads from `src/resources/`)
2. **Packaged build:** Files missing from ASAR archive, `installDefaultApps()` fails silently

The `AppService.installDefaultApps()` method tried to copy from:
```typescript
const defaultAppsDir = path.join(__dirname, "..", "resources", "default-apps");
```

But in packaged builds, this directory didn't exist because `electron-builder` never copied it.

## Solution

### Add resources to electron-builder.json

```json
{
  "files": [
    "dist/**/*",
    "src/electron/main.cjs",
    "src/electron/index.cjs",
    "src/electron/supervisor-logic.cjs",
    "src/electron/preload.cjs",
    "src/electron/ipc/**/*.cjs",
    "src/resources/**/*",  // ← ADDED
    "package.json"
  ]
}
```

## How It Works

### Installation Flow

1. **First Launch:**
   - `AppService.initialize()` calls `installDefaultApps()`
   - Checks if `dist/resources/default-apps/` exists (now included in ASAR)
   - Reads `app-id.txt` from each default app: `bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c`
   - Checks if app already installed in `$PAPR_HOME/apps/{appId}/`
   - If not installed, copies all files to user directory
   - Logs: `[AppService] Installed default app: bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c (home-dashboard)`

2. **Home Button Click:**
   - TabBar checks `settings.preferences.defaultHomeAppId`
   - Default value: `bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c` (set in `DEFAULT_SETTINGS`)
   - Opens home dashboard instead of placeholder

3. **Subsequent Launches:**
   - `installDefaultApps()` sees app already exists
   - Logs: `[AppService] Default app already exists: bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c`
   - Skips installation (no overwrite of user's customizations)

## Bundled Default Apps

### Current Apps

1. **Weekly War Room Dashboard** (`bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c`)
   - Location: `src/resources/default-apps/home-dashboard/`
   - Files: `index.html`, `app.js`, `styles.css`, `metadata.json`, `icon.svg`, `app-id.txt`
   - Purpose: Home dashboard showing job outputs, quick actions, stats

### Adding More Default Apps

To add more bundled apps:

1. Create directory: `src/resources/default-apps/{app-name}/`
2. Add required files:
   - `app-id.txt` - UUID of the app
   - `metadata.json` - Title, description, icon
   - `index.html` - Main entry point
   - All JS/CSS/assets
3. electron-builder automatically includes it (via `src/resources/**/*`)
4. AppService installs on first launch

## Impact

### Before
- **Development:** Home button worked ✅ (files on disk)
- **Packaged build:** Home button showed placeholder ❌ (files missing)
- **User experience:** Inconsistent between dev and production

### After
- **Development:** Home button works ✅
- **Packaged build:** Home button works ✅ (files in ASAR)
- **User experience:** Consistent, professional first impression

## Files Changed

- `electron-builder.json` - Added `src/resources/**/*` to files array

## Testing

### Automated Test (Recommended)

```bash
npm run test:package:quick
```

This verifies:
- ✅ `src/resources/**/*` in electron-builder.json
- ✅ Build succeeds
- ✅ ASAR contains `/src/resources/default-apps/home-dashboard/`

### Manual Test Steps

1. **Build Package:**
   ```bash
   npm run build
   npm run dist:win  # or dist:mac
   ```

2. **Install Fresh:**
   - Uninstall existing Paprwork
   - Delete active workspace under `~/Papr/orgs/.../namespaces/.../` (fresh state)
   - Install newly built package

3. **Verify Installation:**
   - Launch app
   - Check console logs: `[AppService] Installed default app: bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c`
   - Verify files exist: `$PAPR_HOME/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c/`

4. **Test Home Button:**
   - Click home button (house icon) in tab bar
   - Should open Weekly War Room dashboard
   - Should NOT show "Agent Lounge (Coming Soon)" placeholder

5. **Verify Persistence:**
   - Close app
   - Relaunch app
   - Console should show: `[AppService] Default app already exists`
   - Home button should still work

### ASAR Inspection

```bash
# Extract ASAR to verify contents
npx @electron/asar extract release/mac-arm64/Papr\ Work.app/Contents/Resources/app.asar /tmp/asar-test

# Check if resources included
ls -la /tmp/asar-test/src/resources/default-apps/home-dashboard/
```

Should contain:
- `app-id.txt`
- `index.html`
- `metadata.json`
- `icon.svg`
- All JS/CSS files

## Related Issues

- Issue 33: Missing IPC Files in Packaged App (2026-04-05) - Same root cause (files not in electron-builder.json)
- Enhancement 27: Smart Default Provider & Bundled Home Dashboard (2026-03-31) - Original bundling implementation

## Prevention

### Before Every Release

Run the automated test to catch missing files:

```bash
npm run test:package:quick  # Fast config + build check
npm run test:package        # Full build + ASAR verification
```

This prevents issues where features work in dev but fail in production.

### Checklist

- [ ] New resource directories added to `src/resources/`?
- [ ] Included in `electron-builder.json` files array?
- [ ] Test script passes?
- [ ] ASAR inspection shows files?

## Future Enhancements

1. **App Templates:** Bundle multiple default app templates (CRM, Analytics, Project Tracker)
2. **App Store:** Download additional templates from papr-dev-platform
3. **User Overrides:** Settings UI to configure default home app
4. **Update Mechanism:** Update bundled apps without full app reinstall
5. **Version Check:** Track default app versions, offer updates
