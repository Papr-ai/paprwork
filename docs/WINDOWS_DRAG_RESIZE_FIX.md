# Windows Window Dragging and Resizing Fix

**Issue Date:** 2026-04-06  
**Status:** ✅ FIXED

## Problem

On Windows, users couldn't:
1. **Drag the window** by clicking and dragging the titlebar/tab bar area
2. **Resize the window** by dragging edges and corners (though this should work by default)

This made the window feel "stuck" and unusable compared to native Windows apps.

## Root Cause

When using `titleBarStyle: "hidden"` with `titleBarOverlay` on Windows, the drag region behavior needs explicit configuration:

1. **Missing explicit resize flags** - While `resizable: true` is default, it wasn't explicitly set
2. **Incorrect drag regions** - The tab bar had `-webkit-app-region: drag` globally, but this conflicted with Windows' titleBarOverlay implementation
3. **Platform-agnostic CSS** - Same drag region CSS applied to both macOS and Windows, but they behave differently

### macOS vs Windows Drag Regions

| Platform | Implementation | Drag Behavior |
|----------|----------------|---------------|
| **macOS** | `titleBarStyle: "hiddenInset"` + native traffic lights | `-webkit-app-region: drag` works everywhere |
| **Windows** | `titleBarStyle: "hidden"` + titleBarOverlay | Needs explicit drag regions, doesn't inherit properly |

## Solution

### 1. Explicit Window Flags (Electron Main Process)

Added explicit window control flags to ensure Windows knows these operations are allowed:

```javascript
const windowsConfig = {
  ...baseConfig,
  titleBarStyle: "hidden",
  titleBarOverlay: { ... },
  transparent: false,
  backgroundColor: isDarkMode ? "#1C1C1E" : "#F5F5F7",
  // Explicitly enable window operations
  resizable: true,
  minimizable: true,
  maximizable: true,
  closable: true,
};
```

**Why this helps:** Windows' custom titlebar implementation needs explicit permission flags.

### 2. Platform-Specific Drag Regions (CSS)

Separated drag region CSS for macOS vs Windows/Linux:

**TabBar.css - Before:**
```css
.tab-bar {
  -webkit-app-region: drag; /* Applied to all platforms */
}
```

**TabBar.css - After:**
```css
.tab-bar {
  /* No drag region by default */
  -webkit-app-region: none;
}

/* macOS: Make entire tab bar draggable */
body.platform-darwin .tab-bar {
  -webkit-app-region: drag;
}

/* Windows/Linux: Don't make entire bar draggable */
body:not(.platform-darwin) .tab-bar {
  -webkit-app-region: no-drag;
}

/* Windows/Linux: Make tabs area (empty space) draggable */
body:not(.platform-darwin) .tab-bar__tabs {
  -webkit-app-region: drag;
}
```

**Why this works:**
- **macOS:** Native traffic lights work well with global drag region
- **Windows:** titleBarOverlay buttons need the bar itself to be non-draggable, only empty space should drag

### 3. Interactive Elements Stay Clickable

Maintained existing `no-drag` regions for interactive elements:

```css
/* Keep these clickable/interactive */
.tab-bar__nav {
  -webkit-app-region: no-drag; /* Back/forward buttons */
}

.tab-bar__new-btn {
  -webkit-app-region: no-drag; /* New tab button */
}

.tab {
  -webkit-app-region: no-drag; /* Individual tabs */
}
```

## Implementation Details

### Electron Config Changes

**File:** `src/electron/index.cjs`

```javascript
const windowsConfig = {
  ...baseConfig,
  titleBarStyle: "hidden",
  titleBarOverlay: {
    color: isDarkMode ? "#1C1C1E" : "#F5F5F7",
    symbolColor: isDarkMode ? "#FFFFFF" : "#000000",
    height: 52,
  },
  transparent: false,
  backgroundColor: isDarkMode ? "#1C1C1E" : "#F5F5F7",
  // ✅ ADDED: Explicit window operation flags
  resizable: true,
  minimizable: true,
  maximizable: true,
  closable: true,
};
```

### CSS Changes

**File:** `ui/components/Tabs/TabBar.css`

**Changed sections:**
1. `.tab-bar` - Removed global drag, added platform-specific rules
2. `.tab-bar__tabs` - Added Windows-specific drag region

## User Experience

### Before Fix

- ❌ Clicking and dragging tab bar does nothing
- ❌ Window feels "stuck" or frozen
- ✅ Resizing works (native Windows behavior, not affected)
- ✅ Titlebar buttons (min/max/close) work

### After Fix

- ✅ Can drag window by clicking empty space in tab bar
- ✅ Can drag window by clicking between tabs
- ✅ Individual tabs remain clickable (no interference)
- ✅ Back/forward/new tab buttons remain clickable
- ✅ Resizing works (unchanged)
- ✅ Titlebar buttons work (unchanged)

## Platform Differences

### macOS
- **Drag areas:** Entire tab bar + empty space between tabs
- **Native controls:** Traffic lights (left side)
- **Resize:** Native window resize handles
- **Unchanged:** This fix doesn't affect macOS behavior

### Windows
- **Drag areas:** Empty space in tabs area (not entire bar)
- **Native controls:** Min/max/close buttons (right side) via titleBarOverlay
- **Resize:** Native window resize handles (edges + corners)
- **Fixed:** Now can drag window from tab bar empty space

### Linux
- **Drag areas:** Same as Windows (empty space in tabs area)
- **Native controls:** None (frameless window)
- **Resize:** Native window resize handles
- **Behavior:** Follows Windows implementation

## Testing

### Manual Test (Windows)

1. **Drag test:**
   - Click and hold on empty space in tab bar (between tabs or after last tab)
   - Drag mouse → Window should move
   - Click on a tab → Tab should activate (not drag window)
   - Click on back/forward buttons → Should navigate (not drag)

2. **Resize test:**
   - Hover mouse over window edge → Cursor should change to resize cursor
   - Click and drag edge → Window should resize
   - Hover mouse over corner → Cursor should change to diagonal resize
   - Click and drag corner → Window should resize diagonally

3. **Controls test:**
   - Click minimize → Window should minimize
   - Click maximize → Window should maximize/restore
   - Click close → Window should close

### Expected Behavior

| Action | Expected Result |
|--------|-----------------|
| Drag empty tab bar space | Window moves |
| Click tab | Tab activates (no drag) |
| Click navigation buttons | Navigation happens (no drag) |
| Drag window edge | Window resizes |
| Drag window corner | Window resizes diagonally |
| Click minimize button | Window minimizes |
| Click maximize button | Window maximizes/restores |
| Click close button | Window closes |

## Known Limitations

1. **Small drag area:** On Windows, the drag area is only the empty space between/after tabs. This is by design to avoid interfering with tab interactions.

2. **No drag from controls area:** The area where the min/max/close buttons appear (right side, ~148px) is not draggable. This is Windows standard behavior.

3. **Tab drag vs window drag:** If you have many tabs and no empty space, you need to scroll tabs right to expose empty space for window dragging.

## Alternative Solutions Considered

### Option 1: Custom Window Controls (Rejected)

Create custom minimize/maximize/close buttons instead of using Windows native ones.

**Pros:**
- More control over drag regions
- Consistent look across platforms

**Cons:**
- Extra work to implement
- Lose Windows native feel
- Have to handle maximize/restore states manually
- Lose Windows snap features (Win+Left/Right)

**Decision:** Rejected - Native controls provide better Windows integration.

### Option 2: Frameless Window (Rejected)

Use fully frameless window with custom titlebar.

**Pros:**
- Complete control over appearance and behavior

**Cons:**
- Must implement all window controls from scratch
- Must handle all edge cases (snap, fullscreen, etc.)
- More code to maintain
- Potential bugs and edge cases

**Decision:** Rejected - titleBarOverlay provides good balance.

### Option 3: Separate Drag Handle (Considered)

Add a dedicated drag handle area in the titlebar.

**Pros:**
- Clear visual indicator
- Larger drag area

**Cons:**
- Takes up space
- Not typical for modern apps
- Clutters UI

**Decision:** Not needed - Empty tab bar space is sufficient.

## Files Changed

- `src/electron/index.cjs` - Added explicit window operation flags to windowsConfig
- `ui/components/Tabs/TabBar.css` - Platform-specific drag regions
- `docs/WINDOWS_DRAG_RESIZE_FIX.md` - This documentation

## Related Issues

- Issue 32: Windows Title Bar and Transparency Issues (2026-03-31) - Original titleBarOverlay setup
- Issue 34: Windows Titlebar Theme Colors (2026-04-06) - Theme-aware titlebar colors
- Issue 35: Default Home App Not Bundled (2026-04-06) - Home dashboard bundling
- Issue 36: Windows SQLite Performance (2026-04-06) - Database performance

## Future Enhancements

1. **Hover feedback:** Show subtle visual feedback when hovering over draggable areas
2. **Drag cursor:** Change cursor to move cursor when over draggable areas (may be too busy)
3. **Snap regions:** Add visual indicators for Windows snap zones
4. **Custom animations:** Smooth animations for minimize/maximize (native handles this)

## References

- [Electron BrowserWindow Options](https://www.electronjs.org/docs/latest/api/browser-window#new-browserwindowoptions)
- [Electron titleBarOverlay](https://www.electronjs.org/docs/latest/api/browser-window#winsettitlebaroverlayoptions-options-windows)
- [Chromium App Region](https://developer.mozilla.org/en-US/docs/Web/CSS/-webkit-app-region)
- [Windows Window Management](https://docs.microsoft.com/en-us/windows/apps/design/layout/app-window)
