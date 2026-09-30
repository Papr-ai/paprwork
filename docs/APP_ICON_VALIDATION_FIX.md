# App Icon Validation Fix

**Date:** 2026-04-07  
**Issue:** Apps displaying plain text ("chart", "shield") instead of proper icons

## Problem

Agent was creating apps with plain text strings like `"chart"` or `"shield"` as icon values instead of proper SVG markup. The UI code assumed any non-SVG text was an emoji and rendered it directly, causing text labels to appear inside icon circles.

## Root Causes

1. **Insufficient validation**: The Zod schema accepted any string for `icon` field
2. **Contradictory guidance**: SystemPrompt said "DO NOT use emojis" in section 9, but said "SVG string or emoji" in the registry.json format (section on community apps)
3. **Permissive UI rendering**: `AppCard.tsx` tried to render any plain text as emoji without validation

## Solution

### 1. Enhanced Zod Schema Validation (appJobs.ts)

Added `.refine()` to validate icon format:

```typescript
icon: z
  .string()
  .refine(
    (val) => {
      const trimmed = val.trim();
      // Must start with < (SVG) or be a valid emoji (Unicode, not ASCII text)
      const startsWithSvg = trimmed.startsWith('<');
      const isEmoji = trimmed.length <= 4 && /[\p{Emoji}]/u.test(trimmed);
      return startsWithSvg || isEmoji;
    },
    {
      message:
        'Icon must be an SVG string (starting with "<svg") or a valid emoji. Plain text like "chart" or "shield" is not allowed.',
    },
  )
```

**Impact:** Agent will now get an error if it tries to pass plain text, forcing it to use proper SVG.

### 2. UI Fallback for Invalid Icons (AppCard.tsx)

Updated `renderIcon()` to validate icons and fall back to default grid icon:

```typescript
// Check if it's a valid emoji (Unicode character, not plain ASCII text)
const isEmoji = trimmedIcon.length <= 4 && /[\p{Emoji}]/u.test(trimmedIcon);

if (isEmoji) {
  return <span className="app-card__orb-icon" style={{ fontSize: '28px' }}>{artifact.icon}</span>;
}

// Plain text strings like "chart", "shield" - treat as missing icon
console.warn(`App "${artifact.title}" has invalid icon: "${artifact.icon}". Expected SVG markup or emoji.`);
```

**Impact:** Old apps with invalid icons will show the default grid icon instead of text labels.

### 3. Updated SystemPrompt (SystemPrompt.ts)

Changed contradictory statement in community apps section:

```diff
- - `icon`: string (optional — SVG string or emoji)
+ - `icon`: string (REQUIRED — inline SVG string following design system patterns. DO NOT use plain text like "chart" or "shield")
```

### 4. Migration Script (fix-app-icons.mjs)

Created script to fix existing apps with invalid icons:

```bash
npm run fix-app-icons
```

**What it does:**
- Scans all apps in `$PAPR_HOME/data/apps.json`
- Identifies invalid icons (plain text that's not emoji)
- Replaces common text with proper SVG equivalents:
  - `"chart"` → Chart/analytics SVG icon
  - `"shield"` → Security shield SVG icon
  - `"search"` → Magnifying glass SVG icon
  - etc.
- Removes unknown invalid icons (app will use default grid icon)

## Files Changed

### Core Files
- **src/core/tools/appJobs.ts** - Enhanced `createAppSchema` with `.refine()` validation
- **src/core/agents/SystemPrompt.ts** - Fixed contradictory guidance, clarified SVG requirement
- **ui/components/Apps/AppCard.tsx** - Added emoji validation, fallback to default icon
- **ui/components/Apps/AppCard.css** - Added overflow handling for icon container

### Migration & Utilities
- **scripts/fix-app-icons.mjs** - NEW: Migration script to fix existing apps
- **package.json** - Added `fix-app-icons` npm script

## Results

**Before:**
- 4 apps with plain text icons: "chart" (3x), "shield" (1x)
- Text labels visible inside icon orbs in UI
- No validation preventing invalid icons

**After:**
- All 4 apps converted to proper SVG icons ✅
- Zod validation prevents future invalid icons ✅
- UI gracefully handles legacy invalid icons ✅
- Clear console warnings for debugging ✅

## Prevention

**For Agent:**
1. Tool schema now validates icon format (rejects plain text)
2. Clear error messages guide agent to use SVG
3. SystemPrompt has concrete SVG examples
4. No more contradictory "emoji" references

**For UI:**
1. Emoji validation using Unicode regex (`/[\p{Emoji}]/u`)
2. Fallback to default grid icon for invalid values
3. Console warnings for debugging
4. CSS overflow protection

## Testing

Run the migration script to verify it works:

```bash
npm run fix-app-icons
```

Expected output:
```
✓ Fixed 4 app(s) with proper SVG icons
✓ Removed 0 invalid icon(s)
✓ Apps file updated successfully
```

Restart the app to see proper icons in the apps list.

## Icon Guidelines (for reference)

**Valid formats:**
- ✅ SVG markup: `<svg viewBox="0 0 24 24" width="14" height="14">...</svg>`
- ✅ Emojis: `📊`, `🔒`, `🔍` (actual Unicode emojis)

**Invalid formats:**
- ❌ Plain text: `"chart"`, `"shield"`, `"icon"`
- ❌ Icon names: `"fa-chart"`, `"icon-shield"`
- ❌ CSS classes: `"icon icon-chart"`

**Design system standards:**
- Use `stroke="currentColor"` for theme compatibility
- Use `stroke-width="1.5"` or `"2"` for consistency
- Use `fill="none"` for outline-style icons
- Keep simple (1-3 shapes max)
- Size: `width="14" height="14"` in SVG tag

## Related Issues

- Enhancement 28: Mini-App Icon Requirement (CLAUDE.md)
- SystemPrompt section 9: "ALWAYS Include an Icon"
