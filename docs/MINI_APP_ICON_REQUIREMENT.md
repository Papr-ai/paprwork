# Mini-App Icon Requirement Enhancement

**Date:** 2026-03-31

## Problem

Most agent-created mini-apps were using the default generic icon, making the apps list and tabs look unprofessional and hard to scan visually.

## Solution

Enhanced the agent's guidance to **require icons for all mini-apps** through multiple reinforcement layers:

### 1. Tool Schema Enhancement

Updated `createAppSchema` in `src/core/tools/appJobs.ts`:

```typescript
icon: z
  .string()
  .describe(
    "**REQUIRED:** SVG string or emoji for the app logo. Shown in tabs, apps list, and favorites. " +
      "Apps without icons look generic and unprofessional. " +
      'Use a simple inline SVG (e.g. \'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14">...</svg>\') ' +
      'or a single emoji (e.g. \'📊\', \'📈\', \'🔍\'). ' +
      "Keep SVGs simple (1-3 shapes max) for clarity at small sizes. " +
      'Alternatively, add a <link rel="icon" href="data:image/svg+xml,..."> tag in your index.html — it will be auto-extracted.',
  ),
```

**Changes:**
- Marked as "**REQUIRED:**" (emphasized in description)
- Added rationale: "Apps without icons look generic and unprofessional"
- Expanded examples with more emoji options
- Added guidance: "Keep SVGs simple (1-3 shapes max) for clarity at small sizes"
- Still technically optional in Zod (for backward compatibility), but strongly worded

### 2. System Prompt Enhancement

Added new section **"9. ALWAYS Include an Icon"** in `src/core/agents/SystemPrompt.ts`:

```typescript
**9. ALWAYS Include an Icon:**
Every mini-app MUST have an icon — it appears in tabs, the apps list, and favorites.

**✅ GOOD icons:**
- Simple, recognizable SVGs (1-3 shapes)
- Relevant emojis (📊 for charts, 🔍 for search, 📝 for notes)
- Use \`stroke="currentColor"\` for theme compatibility

**❌ BAD:**
- No icon (looks generic and unprofessional)
- Complex SVGs with gradients/shadows (hard to see at 14px)
- Random/unrelated emojis

**Examples:**
\`\`\`typescript
// Chart app
create_app({
  title: "Sales Dashboard",
  icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 3v16a2 2 0 002 2h16" stroke="currentColor" stroke-width="2" fill="none"/><polyline points="7 14 12 9 16 13 21 8" stroke="currentColor" stroke-width="2"/></svg>',
  // ...
})

// Note app
create_app({
  title: "Quick Notes",
  icon: '📝',
  // ...
})
\`\`\`
```

**Renumbered subsequent sections:**
- File Version History: 9 → 11
- Publishing to the Community: 10 → 12

## Implementation Examples

### Simple SVG Icons

```typescript
// Chart/Analytics
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 3v16a2 2 0 002 2h16" stroke="currentColor" stroke-width="2" fill="none"/><polyline points="7 14 12 9 16 13 21 8" stroke="currentColor" stroke-width="2"/></svg>'

// Home
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" stroke="currentColor" stroke-width="2"/></svg>'

// Search
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2" fill="none"/><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2"/></svg>'

// Calendar
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" stroke-width="2"/></svg>'
```

### Emoji Icons

```typescript
// Finance/Money
icon: '💰'

// Social Media
icon: '📱'

// Email
icon: '📧'

// Tasks/Todo
icon: '✅'
```

## Icon Best Practices

**DO:**
- Use `stroke="currentColor"` in SVGs (adapts to theme)
- Keep SVG viewBox at `0 0 24 24` (standard)
- Size to `width="14" height="14"` (tab size)
- Use 1-3 simple shapes (circles, paths, lines)
- Choose emojis that clearly represent the app's purpose

**DON'T:**
- Use gradients or complex fills (hard to see at small sizes)
- Use `fill="blue"` or hardcoded colors (breaks in dark mode)
- Create detailed illustrations (too much detail at 14px)
- Use random/unrelated emojis

## Impact

**Before:**
- Agents rarely included icons
- Apps list showed generic placeholder icons
- Hard to visually distinguish apps

**After:**
- Tool schema emphasizes icons as "REQUIRED"
- System prompt has dedicated section with examples
- Agents should consistently create icons for all apps

## Testing

To verify the change works:
1. Ask agent to create a new mini-app
2. Check that `create_app` call includes an `icon` parameter
3. Verify icon appears in apps list and tab

## Files Changed

- `src/core/tools/appJobs.ts` - Enhanced `createAppSchema` icon description
- `src/core/agents/SystemPrompt.ts` - Added section 9 "ALWAYS Include an Icon", renumbered subsequent sections
- `docs/MINI_APP_ICON_REQUIREMENT.md` - This file

## Related

- Enhancement 26: Default Home App Configuration
- Home Dashboard icon: Uses the same house icon as the home button in TabBar
