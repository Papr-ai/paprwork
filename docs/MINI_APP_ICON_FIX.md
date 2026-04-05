# Mini-App Icon Support - Emoji & SVG Fix

**Fixed:** 2026-03-31

## Problem

Mini-app icons weren't displaying when agents used emojis. The UI components (`AppCard.tsx`, `Tab.tsx`, `FavoritesList.tsx`) used `dangerouslySetInnerHTML` which only works for SVG markup, not plain text emojis.

## Root Cause

The icon rendering logic assumed all icons were HTML/SVG strings and used `dangerouslySetInnerHTML={{ __html: artifact.icon }}`. When agents set emoji icons like `"🕵️"`, they were passed to `dangerouslySetInnerHTML` which couldn't render them properly.

## Solution

Updated all three icon rendering locations to detect whether the icon is SVG or emoji:

### Detection Logic
```typescript
if (icon.trim().startsWith('<svg') || icon.trim().startsWith('<')) {
  // Render as HTML/SVG
  return <span dangerouslySetInnerHTML={{ __html: icon }} />;
} else {
  // Render as plain text (emoji)
  return <span style={{ fontSize: '14px' }}>{icon}</span>;
}
```

### Files Changed

1. **`ui/components/Apps/AppCard.tsx`** - App grid cards (24px emoji)
2. **`ui/components/Tabs/Tab.tsx`** - Tab icons (14px emoji)  
3. **`ui/components/Sidebar/FavoritesList.tsx`** - Favorite list icons (10px emoji)

## What Agents Need to Do

Agents can now use **either format** for mini-app icons:

### Option 1: Emojis (Recommended for simplicity)
```typescript
create_app({
  title: "Agent Painpoints",
  icon: "🕵️",  // ✅ Works now!
  // ... other fields
})
```

### Option 2: SVG (Recommended for theme-aware icons)
```typescript
create_app({
  title: "Sales Dashboard",
  icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 3v16a2 2 0 002 2h16" stroke="currentColor" stroke-width="2" fill="none"/><polyline points="7 14 12 9 16 13 21 8" stroke="currentColor" stroke-width="2"/></svg>',
  // ... other fields
})
```

## Icon Guidelines (from SystemPrompt)

**DO:**
- ✅ Simple emojis: `"📊"`, `"💬"`, `"🔥"`
- ✅ Simple SVGs: 1-3 shapes, `stroke="currentColor"` for theme compatibility
- ✅ Relevant to app purpose

**DON'T:**
- ❌ Missing icon (defaults to generic grid)
- ❌ Complex gradients in SVG
- ❌ Hardcoded colors in SVG (breaks dark mode)
- ❌ Random unrelated emojis

## Examples by Category

### Finance
- 💰 💵 💸 📈 📊 💹 🏦 💳

### Social  
- 💬 📱 👥 🌐 📧 ✉️ 💌

### Email
- 📧 ✉️ 📬 📮 💌

### Tasks
- ✅ ☑️ 📋 📝 🗂️ 📌

### Analytics
- 📊 📈 📉 💹 🔍 📊

## Testing

1. Create an app with emoji icon: `icon: "🕵️"`
2. Open the app → Check tab icon (should show emoji)
3. Go to Apps page → Check card icon (should show emoji)
4. Pin as favorite → Check sidebar icon (should show emoji)

All three locations should now display emojis correctly!

## Impact

- **Before:** Emoji icons invisible, only SVG worked
- **After:** Both emoji and SVG icons work everywhere (tabs, cards, favorites)
- **Agent guidance:** Already emphasized icons are required, now both formats work
