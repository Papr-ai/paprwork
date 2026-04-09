# Missing IPC Files in Packaged App - Fix Documentation

**Issue Date:** 2026-04-05  
**Status:** ✅ FIXED

## Problem

Users downloading the Mac DMG/ZIP experienced a crash on launch with the error:

```
Uncaught Exception:
Error: Cannot find module './ipc/pythonDeps.cjs'
```

The app worked perfectly in development mode (`npm start`) but failed in the packaged production version.

## Root Cause

**Development vs. Production Gap:**

1. **Development mode** - Node.js directly loads files from `src/electron/` directory
   - All files accessible on disk
   - `require('./ipc/pythonDeps.cjs')` works fine

2. **Production mode** - electron-builder packages only files listed in `electron-builder.json`
   - Only explicitly listed files/patterns are included in the ASAR archive
   - Missing files → runtime errors

**The specific issue:**

- `src/electron/index.cjs` line 39 requires `./ipc/pythonDeps.cjs`
- File was added in commit `93ef22d` (2026-03-31)
- `electron-builder.json` was not updated to include the new `ipc/` directory
- Large commit (139 files) made it easy to miss this config update

## Solution

Updated `electron-builder.json` to include the IPC directory:

```json
{
  "files": [
    "dist/**/*",
    "src/electron/main.cjs",
    "src/electron/index.cjs",
    "src/electron/supervisor-logic.cjs",
    "src/electron/preload.cjs",
    "src/electron/ipc/**/*.cjs",  // ← ADDED THIS LINE
    "package.json"
  ]
}
```

## Verification

Created automated test script to prevent this from happening again:

```bash
# Quick test (just config + build, no packaging)
npm run test:package:quick

# Full test (build + package + ASAR verification)
npm run test:package
```

### Test Results

**Pre-Build Checks:**
- ✅ All source files exist
- ✅ electron-builder.json includes all required patterns

**Build:**
- ✅ TypeScript compilation successful
- ✅ dist/ output complete

**Package:**
- ✅ App bundle created
- ✅ ASAR archive contains all required files

**ASAR Contents Verification:**
```bash
$ npx @electron/asar list "release/mac-arm64/Papr Work.app/Contents/Resources/app.asar" | grep pythonDeps
/src/electron/ipc/pythonDeps.cjs  ✅
```

## Files Changed

1. `electron-builder.json` - Added `src/electron/ipc/**/*.cjs` to files array
2. `scripts/test-package-build.mjs` - NEW: Automated package testing script
3. `package.json` - Added `test:package` and `test:package:quick` scripts

## Prevention

**Going forward:**

1. **Always test packaged builds** before releases (not just dev mode)
2. **Run automated tests:**
   ```bash
   npm run test:package:quick  # Before every commit touching electron files
   npm run test:package        # Before every release
   ```
3. **Check electron-builder.json** when adding new Electron files
4. **CI/CD should run package tests** (future enhancement)

## Timeline

- **2026-03-31** - `pythonDeps.cjs` added in commit `93ef22d`
- **2026-04-05** - User reported crash in downloaded version
- **2026-04-05** - Root cause identified, fix applied, tests created
- **Next release** - Fix included in v2.0.18+

## Related

- Enhancement 30: Automatic Hybrid Code Search (introduced pythonDeps.cjs)
- CLAUDE.md: Development best practices

## Testing Checklist

Before every release, verify:

- [ ] Run `npm run test:package:quick` (config + build)
- [ ] Run `npm run test:package` (full package test)
- [ ] All tests pass (no missing files)
- [ ] ASAR contents verified
- [ ] **Stop dev instances** (`pkill -f "Electron.*Papr Work"`)
- [ ] Test the actual DMG/ZIP launches successfully (not just opens and closes)
- [ ] Test on a clean machine (optional but recommended)

## Common Issue: App Opens and Closes Immediately

**Symptom:** You double-click the app, it appears briefly in the dock, then immediately closes.

**Cause:** Another instance is already running (usually `npm start` in a terminal).

**Solution:**
```bash
# Stop all instances first
pkill -f "Electron.*Papr Work"

# Then launch the packaged app
open "release/mac-arm64/Papr Work.app"
```

See `docs/TESTING_PACKAGED_APP.md` for details.

## Impact

- **Before:** Production builds had missing IPC files, crashed on launch
- **After:** All IPC files included, app works in both dev and production
- **Prevention:** Automated tests catch missing files before release
