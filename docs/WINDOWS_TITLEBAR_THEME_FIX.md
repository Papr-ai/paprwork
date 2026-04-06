# Windows Titlebar Theme-Aware Colors Fix

**Issue Date:** 2026-04-06  
**Status:** ✅ FIXED

## Problem

On Windows, the minimize, maximize, and close buttons in the top-right corner had a hardcoded black background (`#1C1C1E`) regardless of whether the user had light or dark mode enabled in Windows settings. This created poor contrast in light mode (black buttons on light background).

## Root Cause

The `titleBarOverlay` configuration in `src/electron/index.cjs` was using hardcoded dark colors:

```javascript
titleBarOverlay: {
  color: "#1C1C1E", // Always dark
  symbolColor: "#FFFFFF", // Always white icons
  height: 52,
}
```

This ignored the Windows theme setting (`nativeTheme.shouldUseDarkColors`).

## Solution

### 1. Import nativeTheme

```javascript
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, powerMonitor, nativeTheme } = require("electron");
```

### 2. Use Theme Detection on Window Creation

```javascript
const isDarkMode = nativeTheme.shouldUseDarkColors;
const windowsConfig = {
  ...baseConfig,
  titleBarStyle: "hidden",
  titleBarOverlay: {
    color: isDarkMode ? "#1C1C1E" : "#F5F5F7", // Dark or light based on theme
    symbolColor: isDarkMode ? "#FFFFFF" : "#000000", // White icons in dark, black in light
    height: 52,
  },
  transparent: false,
  backgroundColor: isDarkMode ? "#1C1C1E" : "#F5F5F7", // Match titlebar
};
```

### 3. Add Dynamic Theme Updates

Listen for theme changes and update the titlebar overlay in real-time:

```javascript
if (isWindows) {
  nativeTheme.on('updated', () => {
    const isDarkMode = nativeTheme.shouldUseDarkColors;
    mainWindow.setTitleBarOverlay({
      color: isDarkMode ? "#1C1C1E" : "#F5F5F7",
      symbolColor: isDarkMode ? "#FFFFFF" : "#000000",
      height: 52,
    });
  });
}
```

## Impact

### Before
- **Dark mode:** Black titlebar with white icons ✅ (worked fine)
- **Light mode:** Black titlebar with white icons ❌ (poor contrast, buttons hard to see)
- **Theme switching:** No response ❌ (required app restart)

### After
- **Dark mode:** Dark titlebar (`#1C1C1E`) with white icons ✅
- **Light mode:** Light titlebar (`#F5F5F7`) with black icons ✅
- **Theme switching:** Titlebar updates instantly ✅

## Files Changed

- `src/electron/index.cjs` - Added nativeTheme import, theme detection, dynamic updates

## Testing

### Manual Test Steps

1. **Light Mode Test:**
   - Set Windows to light mode (Settings → Personalization → Colors → Choose your mode → Light)
   - Launch Paprwork
   - Verify titlebar buttons have light gray background with black icons
   - Verify good contrast with main window

2. **Dark Mode Test:**
   - Set Windows to dark mode
   - Launch Paprwork
   - Verify titlebar buttons have dark background with white icons

3. **Dynamic Update Test:**
   - Launch Paprwork in light mode
   - Switch Windows to dark mode while app is running
   - Verify titlebar updates immediately without restart
   - Switch back to light mode
   - Verify titlebar updates again

### Expected Results

| Windows Theme | Titlebar Color | Icon Color | Contrast |
|---------------|----------------|------------|----------|
| Light Mode | `#F5F5F7` (light gray) | `#000000` (black) | ✅ Good |
| Dark Mode | `#1C1C1E` (dark gray) | `#FFFFFF` (white) | ✅ Good |

## Related Issues

- Issue 32: Windows Title Bar and Transparency Issues (2026-03-31) - Original fix used hardcoded dark colors
- This fix makes the solution theme-aware and dynamic

## Platform Notes

- **macOS:** Not affected - uses native traffic light buttons (always theme-aware)
- **Linux:** Not affected - uses frameless window without titlebar overlay
- **Windows only:** This fix specifically addresses Windows titleBarOverlay behavior

## Future Enhancements

1. **Windows 11 Mica/Acrylic:** Consider using native Windows 11 materials when available
2. **Accent Color:** Use Windows accent color (`systemPreferences.getAccentColor()`) for active state
3. **Per-Monitor Theme:** Handle different themes on multi-monitor setups
4. **Custom Themes:** Allow users to override titlebar colors in settings
