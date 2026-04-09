# Mini-App Icon Requirements - SVG Only (No Emojis)

**Updated:** 2026-03-31

## Design Philosophy

Mini-app icons must match Paprwork's existing design system: **minimal, clean, outline-style SVG icons** with consistent stroke weights and theme compatibility.

## Icon Requirements

### ✅ REQUIRED Format
- **Simple inline SVG** (1-3 shapes maximum)
- **Outline style** using `stroke="currentColor"` and `fill="none"`
- **Consistent stroke width**: `stroke-width="1.5"` or `"2"`
- **Standard viewBox**: `viewBox="0 0 24 24"`
- **Fixed dimensions**: `width="14" height="14"` (tab size)

### ❌ PROHIBITED
- **Emojis** (🚫 DO NOT USE - unprofessional, inconsistent sizing)
- **Filled/solid icons** (use outline style instead)
- **Gradients or shadows** (hard to see at small sizes)
- **Hardcoded colors** like `stroke="blue"` (breaks in dark mode)
- **Complex illustrations** (too detailed at 14px)

## Icon Templates

Copy and adapt these templates for your apps:

### Chart/Analytics
```typescript
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 3v16a2 2 0 002 2h16" stroke="currentColor" stroke-width="2" fill="none"/><polyline points="7 14 12 9 16 13 21 8" stroke="currentColor" stroke-width="2"/></svg>'
```

### Search
```typescript
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2" fill="none"/><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2"/></svg>'
```

### Calendar/Meetings
```typescript
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" stroke-width="1.5"/></svg>'
```

### Home/Dashboard
```typescript
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" stroke="currentColor" stroke-width="2" fill="none"/><polyline points="9 22 9 12 15 12 15 22" stroke="currentColor" stroke-width="2"/></svg>'
```

### Settings/Config
```typescript
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 1v3m0 16v3M4.22 4.22l2.12 2.12m11.32 11.32l2.12 2.12M1 12h3m16 0h3M4.22 19.78l2.12-2.12m11.32-11.32l2.12-2.12" stroke="currentColor" stroke-width="1.5"/></svg>'
```

### File/Document
```typescript
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" stroke-width="1.5"/></svg>'
```

### User/Profile
```typescript
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" stroke="currentColor" stroke-width="1.5"/></svg>'
```

### Email/Messages
```typescript
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M3 7l9 6 9-6" stroke="currentColor" stroke-width="1.5"/></svg>'
```

### Grid/Apps (Default)
```typescript
icon: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="3" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="14" y="3" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="3" y="14" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="14" y="14" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>'
```

## How to Create Custom Icons

1. **Start with a template** - Pick the closest match from above
2. **Modify the paths** - Adjust `d="..."` attributes to match your app's purpose
3. **Keep it minimal** - Maximum 3-4 shapes (circles, paths, rectangles, lines)
4. **Use currentColor** - Always `stroke="currentColor"` for theme compatibility
5. **Test both themes** - Verify it looks good in light and dark mode

## Example: Creating a "Tasks" App Icon

```typescript
// Step 1: Start with checkbox concept
// Step 2: Use rect for box + polyline for checkmark
// Step 3: Keep it simple and clean

create_app({
  title: "Task Manager",
  icon: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><polyline points="6 12 10 16 18 8" stroke="currentColor" stroke-width="2"/></svg>',
  description: "Manage your daily tasks",
  // ...
})
```

## What Agents Must Do

When creating or updating mini-apps, agents MUST:

1. ✅ Include an `icon` field in every `create_app()` call
2. ✅ Use one of the provided templates or adapt them
3. ✅ Ensure `stroke="currentColor"` for theme compatibility
4. ✅ Use outline style (`fill="none"`)
5. ❌ NEVER use emojis

## Where Icons Appear

Icons are displayed in 3 locations:
1. **Apps page** - Large orb with 24px icon
2. **Tab bar** - Small 14px icon next to title
3. **Favorites sidebar** - Small 10px icon (if pinned)

All three locations now properly support SVG icons with theme-aware rendering.

## Migration from Emojis

If existing apps have emoji icons:
1. Leave them as-is (UI now supports both)
2. When updating the app, replace emoji with proper SVG
3. Use the templates above as starting points

## Files Changed

- `src/core/tools/appJobs.ts` - Updated `createAppSchema` to prohibit emojis
- `src/core/agents/SystemPrompt.ts` - Section 9 now has SVG-only templates
- `ui/components/Apps/AppCard.tsx` - Detects emoji vs SVG for backward compatibility
- `ui/components/Tabs/Tab.tsx` - Detects emoji vs SVG for backward compatibility
- `ui/components/Sidebar/FavoritesList.tsx` - Detects emoji vs SVG for backward compatibility

## Related Documentation

- `docs/MINI_APP_ICON_FIX.md` - Technical fix for emoji rendering (backward compatibility)
- `src/resources/agent-docs/APP_AND_JOBS_GUIDE.md` - Complete mini-app creation guide
