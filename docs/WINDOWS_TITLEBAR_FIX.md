# Windows Title Bar and Transparency Fix

**Added:** 2026-03-31  
**Issue:** Windows missing maximize button, window controls overlapping tabs, background too transparent  
**Status:** ✅ FIXED

## Problems

1. **Missing Maximize Button**: Only minimize (-) and close (X) buttons visible
2. **Controls Overlapping Tabs**: Window controls appearing on top of tab bar
3. **Background Too Transparent**: Chat background difficult to read on Windows

## Root Causes

1. **titleBarOverlay Configuration**: Original config had transparent background and low height (40px vs 52px tab bar)
2. **No Tab Bar Padding**: No CSS padding to reserve space for Windows controls
3. **Transparent Background**: Windows config used `transparent: true` with alpha background, making content hard to read

## Solutions

### 1. Updated titleBarOverlay Configuration

Changed from transparent to solid background with proper height:

```javascript
// Before
const windowsConfig = {
  ...baseConfig,
  titleBarStyle: "hidden",
  titleBarOverlay: {
    color: "#00000000", // Transparent
    symbolColor: "#999999", // Gray
    height: 40,
  },
  transparent: true,
  backgroundColor: "#00000000",
};

// After
const windowsConfig = {
  ...baseConfig,
  titleBarStyle: "hidden",
  titleBarOverlay: {
    color: "#1C1C1E", // Solid dark background
    symbolColor: "#FFFFFF", // White for visibility
    height: 52, // Match tab bar height
  },
  transparent: false, // Solid background on Windows
  backgroundColor: "#1C1C1E",
};
```

### 2. Added Tab Bar Padding for Windows

Reserved space on the right for window controls:

```css
/* Windows/Linux: Reserve space for window controls on the right */
body:not(.platform-darwin) .tab-bar {
  /* Windows title bar overlay is ~140px wide (3 buttons × ~46px each) */
  padding-right: 148px;
}
```

### 3. Platform Detection

Added platform class to body element for platform-specific styling:

```typescript
// In App.tsx
useEffect(() => {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) {
    document.body.classList.add('platform-darwin');
  } else if (platform.includes('win')) {
    document.body.classList.add('platform-win32');
  } else {
    document.body.classList.add('platform-linux');
  }
}, []);
```

### 4. Solid Background for Windows/Linux

Changed from transparent to solid background for better readability:

```css
/* Windows: Use solid background (less transparent) */
body.platform-win32,
body.platform-linux {
  background: #F5F5F7; /* Solid light background */
}

@media (prefers-color-scheme: dark) {
  body.platform-win32,
  body.platform-linux {
    background: #1C1C1E; /* Solid dark background */
  }
}
```

## Platform Differences

| Feature | macOS | Windows/Linux |
|---------|-------|---------------|
| **Window Controls** | Left (traffic lights) | Right (minimize, maximize, close) |
| **Background** | Transparent with vibrancy | Solid color |
| **Title Bar** | hiddenInset | hidden with overlay |
| **Tab Bar Padding** | Default (8px both sides) | Right padding (148px) |

## Files Changed

- `src/electron/index.cjs` - Updated Windows config
  - Changed `titleBarOverlay.color` to solid `#1C1C1E`
  - Changed `titleBarOverlay.symbolColor` to white
  - Increased `titleBarOverlay.height` to 52px
  - Set `transparent: false`
  - Set solid `backgroundColor`

- `ui/App.tsx` - Added platform detection
  - Adds `platform-darwin`, `platform-win32`, or `platform-linux` class to body

- `ui/components/Tabs/TabBar.css` - Reserved space for controls
  - Added `padding-right: 148px` for non-macOS platforms

- `ui/styles/liquid-glass.css` - Solid Windows background
  - Changed body background to solid colors on Windows/Linux
  - Maintains transparency on macOS for native vibrancy

## Testing

### Manual Test Cases

#### Windows

1. **Window Controls Visible**
   - All three buttons visible: Minimize, Maximize, Close
   - Buttons have white icons on dark background
   - Height matches tab bar (52px)

2. **No Overlap**
   - Tabs don't extend under window controls
   - 148px padding on right prevents overlap
   - Tabs scroll correctly without being cut off

3. **Background Readability**
   - Light mode: Solid `#F5F5F7` background
   - Dark mode: Solid `#1C1C1E` background
   - Text is clearly readable against background

#### macOS (Regression Test)

1. **Traffic Lights Still Work**
   - Standard macOS traffic lights on left
   - No padding on right (controls on left)
   - Transparent background with vibrancy still active

2. **Tab Bar Layout**
   - Tabs start after traffic lights
   - Full width available for tabs
   - Transparency and blur effects maintained

#### Linux (Similar to Windows)

1. **No Native Controls**
   - Uses frameless window
   - May need custom close/minimize buttons in future
   - Solid background like Windows

## Known Limitations

### Linux

Currently, Linux uses a frameless window without native controls. Users must:
- Use Alt+F4 to close (or implement custom buttons)
- Use window manager shortcuts to minimize/maximize

**Future Enhancement**: Add custom window control buttons for Linux in the tab bar.

### Windows Theme Integration

The solid background (`#1C1C1E`) doesn't adapt to Windows accent color. 

**Future Enhancement**: Could read Windows theme via:
```javascript
const { nativeTheme } = require('electron');
const accentColor = nativeTheme.shouldUseDarkColors ? '#1C1C1E' : '#F5F5F7';
```

## Future Enhancements

### 1. Custom Window Controls for Linux

Add custom buttons in TabBar for Linux:

```typescript
{!isMac && (
  <div className="custom-window-controls">
    <button onClick={() => window.electronAPI.minimize()}>−</button>
    <button onClick={() => window.electronAPI.maximize()}>□</button>
    <button onClick={() => window.electronAPI.close()}>×</button>
  </div>
)}
```

### 2. Aero Glass Effect on Windows

Could enable Mica/Acrylic material on Windows 11:

```javascript
if (process.platform === 'win32') {
  const { VibrancyView } = require('electron-acrylic-window');
  VibrancyView.setVibrancy(mainWindow, 'mica');
}
```

### 3. Adaptive Title Bar Color

Read system accent color and adapt title bar:

```javascript
const { nativeTheme } = require('electron');
titleBarOverlay: {
  color: nativeTheme.shouldUseDarkColors ? '#1C1C1E' : '#F5F5F7',
  // ...
}
```

## Related Documentation

- [Electron BrowserWindow Options](https://www.electronjs.org/docs/latest/api/browser-window#new-browserwindowoptions)
- [Electron Title Bar Overlay](https://www.electronjs.org/docs/latest/tutorial/window-customization#windows)
- [CSS :has() selector](https://developer.mozilla.org/en-US/docs/Web/CSS/:has)

## Impact

- **Before**: 
  - Only 2 buttons visible (minimize, close)
  - Controls overlapping tabs
  - Background too transparent (hard to read)

- **After**:
  - All 3 buttons visible (minimize, maximize, close)
  - Tabs properly padded, no overlap
  - Solid background (easy to read)
  - Platform-specific styling (macOS keeps transparency)
