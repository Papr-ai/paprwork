# Auto-Launch Post-Installation Fix

**Problem:** After installation, users had to manually search for and open the app.

**Solution:** Configure installers to auto-launch the app after installation completes.

---

## Changes Made

### Windows (NSIS Installer)

Added to `electron-builder.json` → `nsis`:

```json
{
  "runAfterFinish": true,
  "createDesktopShortcut": true,
  "createStartMenuShortcut": true
}
```

**Behavior:**
- After installation completes, a checkbox appears: "Run Papr Work"
- Checked by default
- User can uncheck if they don't want auto-launch
- Creates desktop + start menu shortcuts for easy access

---

### Mac (PKG Installer)

Added to `electron-builder.json` → `pkg`:

```json
{
  "scripts": "build/pkg-scripts"
}
```

Created post-install script: `build/pkg-scripts/postinstall`

```bash
#!/bin/bash
# Opens the app after PKG installation completes
sleep 1
open -a "Papr Work" || true
exit 0
```

**Behavior:**
- After PKG installation completes, the app automatically opens
- Uses macOS `open` command (standard system behavior)
- Fails silently if app can't be opened (won't block installation)

---

### Linux (.deb Package)

Added to `electron-builder.json` → `linux`:

```json
{
  "desktop": {
    "Name": "Papr Work",
    "Comment": "AI-powered desktop assistant",
    "Categories": "Utility;Productivity;",
    "StartupWMClass": "papr-work"
  }
}
```

**Behavior:**
- Creates proper desktop entry in application menu
- App appears in launcher/app grid immediately after installation
- Shows in "Utility" and "Productivity" categories
- Easier to find and launch

---

## User Experience Improvements

### Before
1. User downloads installer
2. User opens installer
3. Installation completes
4. **User must search for "Papr Work" manually**
5. User opens app

### After

**Windows:**
1. User downloads installer
2. User opens installer
3. Installation completes
4. **App automatically launches** (or user sees "Run Papr Work" checkbox)

**Mac:**
1. User downloads PKG
2. User opens PKG
3. Installation completes
4. **App automatically opens**

**Linux:**
1. User downloads .deb
2. User installs package
3. **App appears in launcher immediately**
4. User clicks app in launcher (one click)

---

## Testing

### Windows
```bash
# Build installer
npm run build:win

# Test:
# 1. Run PaprWork-Setup-{version}.exe
# 2. Complete installation
# 3. Verify "Run Papr Work" checkbox appears and is checked
# 4. Verify app launches after clicking "Finish"
# 5. Verify desktop shortcut was created
# 6. Verify Start Menu shortcut was created
```

### Mac
```bash
# Build PKG
npm run build:mac

# Test:
# 1. Run Papr Work-{version}.pkg
# 2. Complete installation
# 3. Verify app automatically opens after installation
# 4. Check /Applications/Papr Work.app exists
```

### Linux
```bash
# Build .deb
npm run build:linux

# Test:
# 1. Install: sudo dpkg -i paprwork_{version}_amd64.deb
# 2. Verify app appears in application launcher
# 3. Verify it's in Utility/Productivity categories
# 4. Click to launch from launcher
```

---

## Notes

### Why not "one-click" installer for Windows?

We kept `"oneClick": false` because:
- Users expect to see where the app is being installed
- Some users want to change the install directory
- One-click installers feel less "professional" for desktop apps
- Current approach follows standard Windows installer UX

### Why post-install script for Mac?

- macOS doesn't allow PKG installers to auto-launch apps directly (security)
- Post-install scripts run as root and can execute `open` command
- This is the standard approach used by professional Mac installers
- Fails gracefully if app can't be opened (won't break installation)

### Why desktop entry for Linux?

- Linux package managers don't auto-launch apps after installation
- Best we can do is make the app immediately visible in launcher
- Desktop entry ensures proper integration with GNOME/KDE/etc.
- Follows freedesktop.org standards

---

## Security Considerations

### Windows
- `runAfterFinish` is optional (user can uncheck)
- App launches with user permissions (not elevated)
- Standard NSIS behavior used by major apps (VS Code, Discord, etc.)

### Mac
- Post-install script runs as root (PKG requirement)
- Uses system `open` command (not executing arbitrary code)
- App launches with user permissions (not root)
- Fails silently if `open` fails (won't break installation)
- Script is signed and notarized along with PKG

### Linux
- No auto-launch (follows Linux conventions)
- Desktop entry uses standard freedesktop.org format
- No elevated permissions required after installation

---

## Future Improvements

1. **Windows:** Add first-run setup wizard
2. **Mac:** Add welcome window with quick start guide
3. **Linux:** Consider creating Snap/Flatpak for better integration
4. **All:** Track installation → first-launch conversion in analytics

---

**Fix Applied:** 2026-05-04  
**Files Changed:**
- `electron-builder.json`
- `build/pkg-scripts/postinstall` (created)
