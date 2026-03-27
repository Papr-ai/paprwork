# App Version and Auto-Updates

**Added:** 2026-03-26

This document explains how Paprwork displays the app version and checks for updates.

## Overview

Paprwork V2 includes:
1. **Version Display** - Shows current app version in Settings > About tab
2. **Auto-Update Checking** - Checks GitHub Releases for new versions automatically
3. **Update Installation** - Downloads and installs updates with one click

## Architecture

### Frontend (UI)

**Files:**
- `ui/hooks/useAppUpdater.ts` - React hook for managing update state
- `ui/components/Settings/SettingsView.tsx` - About tab with version display
- `ui/types/electron.d.ts` - TypeScript definitions for updater API
- `ui/vite.config.ts` - Injects version into HTML at build time

**How Version is Displayed:**
1. At build time, Vite reads version from `package.json` (via `vite.config.ts`)
2. Vite injects `<meta name="app-version" content="2.0.10" />` into `index.html`
3. React hook reads version from meta tag on mount
4. Settings > About tab displays the version

**Update Status Flow:**
```
Main Process (Electron)
    ↓ (IPC: updater:status)
UI Hook (useAppUpdater)
    ↓ (React state)
Settings About Tab (UI)
```

### Backend (Electron)

**Files:**
- `src/electron/index.cjs` - Auto-updater setup and IPC handlers
- `package.json` - App version (source of truth)

**Auto-Updater Configuration:**
```javascript
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
```

**Checking Schedule:**
- On app launch (after 5 second delay)
- Every 4 hours while app is running
- Manually via "Check for Updates" button in Settings > About

**IPC Channels:**
- `updater:status` - Main → Renderer (update status events)
- `updater:check` - Renderer → Main (manual check trigger)
- `updater:install` - Renderer → Main (install and restart)

## Update States

| State | Description | UI Action |
|-------|-------------|-----------|
| `checking` | Checking GitHub for updates | Show spinner |
| `available` | New version found | Show "Download" |
| `downloading` | Downloading update | Show progress % |
| `ready` | Update downloaded | Show "Install & Restart" |
| `not-available` | App is up to date | Show checkmark |
| `error` | Update check failed | Show error message |

## Usage

### For Users

1. Open Settings (gear icon in sidebar)
2. Click "About" tab
3. See current version and update status
4. Click "Check for Updates" to manually check
5. Click "Install Update & Restart" when update is ready

### For Developers

**Update the version:**
```bash
# Edit package.json version field
"version": "2.0.11"

# Rebuild UI (version gets injected into HTML)
npm run build:ui

# Create release on GitHub (triggers auto-updater)
git tag v2.0.11
git push --tags
```

**Test auto-updater:**
```bash
# In development, auto-updater is disabled
# To test, create a production build:
npm run dist:mac

# Open the built app, check Settings > About
open dist/mac/Paprwork.app
```

## GitHub Releases Integration

The auto-updater uses `electron-updater` which checks GitHub Releases for:
- Latest release tag (e.g., `v2.0.11`)
- Release assets (`.dmg`, `.zip`, `latest-mac.yml`)
- Release notes (displayed in UI)

**Required files for auto-update:**
- `dist/mac/Paprwork-2.0.11.dmg` - Installer
- `dist/mac/latest-mac.yml` - Update metadata

These are generated automatically by `electron-builder` when running `npm run dist:mac`.

## Security

- Updates are downloaded over HTTPS from GitHub
- `electron-updater` verifies code signatures (macOS)
- No update is applied without user consent (install button click)
- Auto-updates only work in production builds (packaged app)

## Configuration

**Auto-updater settings:**
```javascript
// src/electron/index.cjs
autoUpdater.autoDownload = true;         // Auto-download when available
autoUpdater.autoInstallOnAppQuit = true; // Install on quit
autoUpdater.logger = null;               // Custom logging
```

**Check intervals:**
- Initial check: 5 seconds after launch
- Periodic check: Every 4 hours

**Vite HTML injection:**
```typescript
// ui/vite.config.ts
{
  name: "html-transform",
  transformIndexHtml(html) {
    return html.replace(
      '<meta name="viewport"',
      `<meta name="app-version" content="${appVersion}" />\n    <meta name="viewport"`
    );
  },
}
```

## Troubleshooting

**Version shows "2.0.10" instead of latest:**
- Check that `package.json` version is correct
- Rebuild UI: `npm run build:ui`
- Verify meta tag in `dist/ui/index.html`

**"Check for Updates" does nothing:**
- Check console for errors
- Verify GitHub repository has releases
- Ensure `electron-updater` is installed
- Check that app is packaged (dev mode doesn't support updates)

**Update download fails:**
- Check internet connection
- Verify GitHub releases have correct assets
- Check electron-updater logs in console

## Future Enhancements

- [ ] Show update changelog in a modal
- [ ] Support beta/alpha release channels
- [ ] Background download progress notification
- [ ] Rollback to previous version if update fails
- [ ] Custom update server (not just GitHub)

## References

- [electron-updater documentation](https://www.electron.build/auto-update)
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases)
- [Vite HTML Transform](https://vitejs.dev/guide/api-plugin.html#transformindexhtml)
