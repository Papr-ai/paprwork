# AuthWall CSS Variables Update

**Date:** 2026-04-12  
**Enhancement:** Convert hardcoded colors to CSS variables for theme support  
**Status:** ✅ Complete

## Problem

The AuthWall component used hardcoded colors and backgrounds that didn't adapt to light/dark mode automatically. The "Papr" text on the right side, all text elements, and background colors had fixed values, requiring manual dark mode overrides.

## Solution

Converted all colors and backgrounds to use CSS variables from the Liquid Glass design system. This makes the AuthWall automatically adapt to both light and dark modes without needing explicit overrides.

## Changes Made

### 1. Main Background
**Before:**
```css
.auth-wall {
  background: #131417;
}

.auth-wall--loading {
  background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
}
```

**After:**
```css
.auth-wall {
  background: var(--background-color);
}

.auth-wall--loading {
  background: var(--background-color);
}
```

### 2. Left Side (Sign In Form) Background
**Before:**
```css
.auth-wall-left {
  background: rgba(255, 255, 255, 0.03);
}
```

**After:**
```css
.auth-wall-left {
  background: var(--glass-bg);
}
```

### 3. Right Side (Branding) Background
**Before:**
```css
.auth-wall-right {
  background: rgba(19, 20, 23, 0.6);
}
```

**After:**
```css
.auth-wall-right {
  background: var(--panel-bg);
}
```

### 4. Title and Subtitle
**Before:**
```css
.auth-wall-title {
  color: #212721;
}

.auth-wall-subtitle {
  color: #9B9B9B;
}
```

**After:**
```css
.auth-wall-title {
  color: var(--text-color);
}

.auth-wall-subtitle {
  color: var(--text-secondary);
}
```

### 5. Status and Hint Text
**Before:**
```css
.auth-wall-status {
  color: #0f1419;
}

.auth-wall-hint {
  color: rgba(15, 20, 25, 0.5);
}

.auth-wall-loading-text {
  color: rgba(0, 0, 0, 0.6);
}
```

**After:**
```css
.auth-wall-status {
  color: var(--text-color);
}

.auth-wall-hint {
  color: var(--text-secondary);
}

.auth-wall-loading-text {
  color: var(--text-secondary);
}
```

### 6. Footer Text and Links
**Before:**
```css
.auth-wall-footer-text {
  color: rgba(15, 20, 25, 0.6);
}

.auth-wall-link {
  color: #0080FF;
}

.auth-wall-link:hover {
  color: #0070E0;
}

.auth-wall-terms {
  color: rgba(15, 20, 25, 0.4);
}
```

**After:**
```css
.auth-wall-footer-text {
  color: var(--text-secondary);
}

.auth-wall-link {
  color: var(--link-color);
}

.auth-wall-link:hover {
  color: var(--link-hover);
}

.auth-wall-terms {
  color: var(--text-tertiary);
}
```

### 7. Papr Logo Text (Right Side)
**Before:**
- SVG with hardcoded colors
- Manual dark mode override with filter

**After:**
```css
.auth-wall-logo-text {
  width: 180px;
  height: auto;
  color: var(--text-color);
}

/* In dark mode, invert the logo colors */
@media (prefers-color-scheme: dark) {
  .auth-wall-logo-text {
    filter: brightness(0) invert(1);
  }
}
```

### 8. Simplified Dark Mode Section
**Before:**
- 50+ lines of dark mode color and background overrides
- Every element had explicit dark mode values

**After:**
```css
@media (prefers-color-scheme: dark) {
  /* Backgrounds automatically adapt via CSS variables */
  
  /* Papr logo text in white for dark mode */
  .auth-wall-logo-text {
    filter: brightness(0) invert(1);
  }
}
```

## CSS Variables Used

From `liquid-glass.css`:

### Light Mode
```css
:root {
  /* Text */
  --text-color: #1D1D1F;           /* Primary text */
  --text-secondary: #6E6E73;       /* Secondary text */
  --text-tertiary: #8E8E93;        /* Tertiary text */
  --link-color: #0080FF;           /* Links */
  --link-hover: #0066CC;           /* Link hover */
  
  /* Backgrounds */
  --background-color: linear-gradient(...); /* Main background */
  --glass-bg: rgba(255, 255, 255, 0.65);   /* Glass left side */
  --panel-bg: rgba(236, 236, 236, 0.75);   /* Panel right side */
}
```

### Dark Mode
```css
@media (prefers-color-scheme: dark) {
  :root {
    /* Text */
    --text-color: #F2F2F7;         /* Primary text (dark) */
    --text-secondary: #AEAEB2;     /* Secondary text (dark) */
    --text-tertiary: #8E8E93;      /* Tertiary text (dark) */
    /* Links remain the same in both modes */
    
    /* Backgrounds */
    --background-color: linear-gradient(...); /* Dark gradient */
    --glass-bg: rgba(14, 18, 28, 0.55);      /* Dark glass */
    --panel-bg: rgba(44, 44, 46, 0.75);      /* Dark panel */
  }
}
```

## Benefits

1. **Automatic Theme Adaptation** - No manual dark mode overrides needed
2. **Consistency** - Uses same colors and backgrounds as rest of app
3. **Maintainability** - Change colors once in liquid-glass.css, applies everywhere
4. **Less Code** - Reduced dark mode section from 50+ lines to 5 lines (90% reduction)
5. **Future-Proof** - Any new theme modes automatically work
6. **Liquid Glass Effect** - Proper translucent backgrounds with blur

## Visual Result

### Light Mode
- Main background: Light gradient
- Left side: Translucent white glass (`rgba(255, 255, 255, 0.65)`)
- Right side: Light panel (`rgba(236, 236, 236, 0.75)`)
- Title: Dark text (`#1D1D1F`)
- Subtitle: Gray text (`#6E6E73`)
- Links: Blue (`#0080FF`)
- Papr logo: Dark (original colors)

### Dark Mode
- Main background: Dark gradient
- Left side: Translucent dark glass (`rgba(14, 18, 28, 0.55)`)
- Right side: Dark panel (`rgba(44, 44, 46, 0.75)`)
- Title: Light text (`#F2F2F7`)
- Subtitle: Light gray (`#AEAEB2`)
- Links: Blue (same)
- Papr logo: White (inverted via filter)

## Testing

✅ Light mode - all text and backgrounds readable with proper contrast  
✅ Dark mode - all text and backgrounds readable with proper contrast  
✅ Glass effect works in both modes  
✅ Logo adapts to theme automatically  
✅ Links maintain blue color in both modes  
✅ Hover states work correctly  

## Files Changed

- `ui/components/Auth/AuthWall.css`:
  - Updated 3 background properties to use CSS variables
  - Updated 8 text color properties to use CSS variables
  - Simplified dark mode section from 50+ lines to 5 lines
  - Added logo text theme support

## Related

- Liquid Glass design system (`ui/styles/liquid-glass.css`)
- Issue 52: Auth0 Double HTTPS & AuthWall Design Fix
- Original split-screen AuthWall implementation

## Impact

- **Before:** Hardcoded colors and backgrounds, 50+ lines of dark mode overrides
- **After:** CSS variables throughout, 5 lines of dark mode styles, automatic theme adaptation ✅
- **Code Reduction:** 90% less dark mode code
- **Maintenance:** Fully centralized color and background management
- **Theme Consistency:** Matches rest of app's Liquid Glass aesthetic
