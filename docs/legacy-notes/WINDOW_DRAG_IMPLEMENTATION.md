# Window Drag Implementation

## Overview

Implemented native macOS window dragging functionality, allowing users to click and drag the window from the top bar areas (sidebar header and tab bar) just like any other macOS app.

## How It Works

Uses Electron's `-webkit-app-region` CSS property to define draggable and non-draggable areas:
- **`-webkit-app-region: drag`** - Makes area draggable for window movement
- **`-webkit-app-region: no-drag`** - Makes area clickable/interactive (overrides parent drag)

## Draggable Areas

### 1. Sidebar Header
- **Area**: The top section of the sidebar with "Paprwork" title
- **CSS**: `.sidebar__header`
- **Why**: Empty space at the top of the window, natural drag target

### 2. Tab Bar
- **Area**: The entire tab bar container (52px height)
- **CSS**: `.tab-bar`
- **Why**: Allows dragging from empty space between/around tabs

### 3. Empty Tab Space
- **Area**: The tabs container when there are no tabs or empty space
- **CSS**: `.tab-bar__tabs`
- **Why**: Users can drag from the empty area to the right of tabs

## Interactive (Non-Draggable) Areas

All interactive elements are marked as `no-drag` to remain clickable:

### Tab Bar Elements
- **Back/Forward buttons** - `.tab-bar__nav`
- **Individual tabs** - `.tab`
- **New tab button** - `.tab-bar__new-btn`

### Sidebar Elements
- **Navigation items** - `.sidebar__nav`
- **Scrollable content** - `.sidebar__content`
- **All buttons and clickable items**

## CSS Changes

### `ui/components/Sidebar/Sidebar.css`
```css
/* Header - DRAGGABLE */
.sidebar__header {
  -webkit-app-region: drag;
  -webkit-user-select: none;
  user-select: none;
}

/* Content - CLICKABLE */
.sidebar__content {
  -webkit-app-region: no-drag;
}

/* Navigation - CLICKABLE */
.sidebar__nav {
  -webkit-app-region: no-drag;
}
```

### `ui/components/Tabs/TabBar.css`
```css
/* Tab bar - DRAGGABLE */
.tab-bar {
  -webkit-app-region: drag;
  -webkit-user-select: none;
  user-select: none;
}

/* Navigation buttons - CLICKABLE */
.tab-bar__nav {
  -webkit-app-region: no-drag;
}

/* Tabs container - DRAGGABLE (empty space) */
.tab-bar__tabs {
  -webkit-app-region: drag;
}

/* New tab button - CLICKABLE */
.tab-bar__new-btn {
  -webkit-app-region: no-drag;
}
```

### `ui/components/Tabs/Tab.css`
```css
/* Individual tabs - CLICKABLE */
.tab {
  -webkit-app-region: no-drag;
}
```

## User Experience

### Draggable From:
✅ Sidebar header area (top of sidebar)  
✅ Tab bar background  
✅ Empty space around tabs  
✅ Empty space to the right of tabs

### Still Clickable:
✅ Back/Forward buttons  
✅ Home button  
✅ Individual tabs (click to switch, drag to reorder)  
✅ New tab button  
✅ Sidebar navigation items  
✅ All buttons and interactive elements

## Technical Notes

1. **User Selection Disabled**: Added `-webkit-user-select: none` to draggable areas to prevent text selection while dragging

2. **Hierarchy**: Child elements with `no-drag` override parent `drag` regions, allowing fine-grained control

3. **Tab Dragging**: Tabs themselves are `no-drag` so they can be dragged for reordering (HTML drag & drop) without triggering window drag

4. **Empty Space**: The `.tab-bar__tabs` container is draggable, so clicking/dragging empty space moves the window, but clicking tabs themselves doesn't

## Testing

All 105 tests pass ✅

No changes to functionality, only CSS additions for window dragging UX.

## Files Modified

1. `ui/components/Sidebar/Sidebar.css` - Made header draggable, content clickable
2. `ui/components/Tabs/TabBar.css` - Made bar draggable, buttons clickable
3. `ui/components/Tabs/Tab.css` - Made tabs clickable for tab operations
