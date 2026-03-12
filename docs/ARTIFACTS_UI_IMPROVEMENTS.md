# Artifacts UI Improvements

**Date:** 2026-03-07
**Changes:** Auto-favorite sync, reorder sidebar, rename to Artifacts, consistent icon styling

## Summary of Changes

### 1. ✅ Auto-add to Favorites When Favoriting
**Problem:** Users had to manually drag apps/documents to favorites sidebar even after favoriting them in the gallery view.

**Solution:**
- Added custom event `papr-favorite-added` dispatched when toggling favorite ON
- `useArtifacts.ts` now broadcasts event with artifact metadata (id, type, title, icon)
- `FavoritesList.tsx` listens for this event and automatically adds to favorites sidebar
- Also syncs with SQLite via `app:toggle_favorite_tab`

**Files Changed:**
- `ui/hooks/useArtifacts.ts` - Added event dispatch in `toggleFavorite()`
- `ui/components/Sidebar/FavoritesList.tsx` - Added event listener in useEffect

### 2. ✅ Apps Above Documents in Sidebar
**Problem:** Documents appeared before Apps in navigation.

**Solution:**
- Reordered sidebar nav buttons: Chat → Apps → Artifacts (was Chat → Documents → Apps)

**Files Changed:**
- `ui/components/Sidebar/Sidebar.tsx` - Swapped order of NavButton components

### 3. ✅ Rename "Documents" to "Artifacts"
**Problem:** Inconsistent naming - should match the existing "artifacts" terminology.

**Solution:**
- Sidebar button label: "Documents" → "Artifacts"
- Tab title when opening documents gallery: "Documents" → "Artifacts"
- Search placeholder: "Search documents..." → "Search artifacts..."
- Create input placeholder: "New document name..." → "New artifact name..."
- Empty state text: "No documents yet" → "No artifacts yet"
- Section labels: "All Documents" → "All Artifacts"

**Files Changed:**
- `ui/components/Sidebar/Sidebar.tsx` - Updated nav button label + view mapping
- `ui/components/Documents/DocumentsView.tsx` - Updated all user-facing text

### 4. ✅ Style Document Icons Like Apps
**Problem:** Document icons in favorites sidebar and tabs were plain SVG, not styled with glass orb like apps.

**Solution:**
- **Favorites:** Updated `FavoritesList.tsx` getIcon() to wrap BOTH app AND document types in glass orb
- **Tabs:** Updated `Tab.tsx` getIcon() to wrap BOTH app AND document types in glass orb
- Documents use same purple/pink gradient as document cards

**Files Changed:**
- `ui/components/Sidebar/FavoritesList.tsx` - Extended glass orb wrapper condition
- `ui/components/Tabs/Tab.tsx` - Extended glass orb wrapper condition + added "documents" icon mapping

## Technical Implementation Details

### Event-Based Favorite Sync

```typescript
// useArtifacts.ts - Dispatch event when favoriting
if (updated.favorite) {
  window.dispatchEvent(
    new CustomEvent("papr-favorite-added", {
      detail: {
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        icon: artifact.icon,
      },
    }),
  );
}

// FavoritesList.tsx - Listen for event
useEffect(() => {
  const handleFavoriteAdded = (event: Event) => {
    const { id, type, title, icon } = (event as CustomEvent).detail;
    
    // Check if already in favorites
    if (favorites.some((f) => f.id === id)) return;
    
    // Add to favorites
    const newFav: Favorite = { id, type, title, icon };
    gateway.send('app:toggle_favorite_tab', { tabId: id });
    setFavorites((prev) => [...prev, newFav]);
  };

  window.addEventListener("papr-favorite-added", handleFavoriteAdded);
  return () => window.removeEventListener("papr-favorite-added", handleFavoriteAdded);
}, [favorites]);
```

### Glass Orb Icon Wrapper

**Before (Apps only):**
```typescript
if (tab.type === "app") {
  return <span className="tab__glass-orb">{innerIcon}</span>;
}
```

**After (Apps AND Documents):**
```typescript
if (tab.type === "app" || tab.type === "document") {
  const innerIcon = tab.icon ? customIcon : defaultIcon;
  return <span className="tab__glass-orb">{innerIcon}</span>;
}
```

Applied to:
- `FavoritesList.tsx` - getIcon()
- `Tab.tsx` - getIcon()

### Sidebar Navigation Order

```typescript
<NavButton label="Chat" />
<NavButton label="Apps" />      // ← Moved up
<NavButton label="Artifacts" /> // ← Renamed + moved down
```

## User Experience Flow

### Before
1. User clicks ⭐ on document card
2. Document is favorited (star turns gold)
3. User must manually drag document to Favorites sidebar
4. User sees "Documents" in sidebar below Apps

### After
1. User clicks ⭐ on document/app card
2. Item is favorited (star turns gold)
3. **Item automatically appears in Favorites sidebar** ✨
4. User sees "Apps" then "Artifacts" in sidebar (consistent order)
5. Document icons have same glass orb styling as apps (visual consistency)

## Visual Consistency

All artifact icons (apps and documents) now have consistent glass orb styling across:
- ✅ Gallery cards (already had orbs)
- ✅ Favorites sidebar (now added)
- ✅ Tab bar (now added)

This creates a unified visual language where:
- **Blue/cyan orbs** = Apps
- **Purple/pink orbs** = Documents (artifacts)
- **Plain icons** = Chat, Settings, etc.

## Files Modified

1. `ui/components/Sidebar/Sidebar.tsx` - Renamed to Artifacts, reordered nav
2. `ui/components/Documents/DocumentsView.tsx` - Updated all text to "Artifacts"
3. `ui/hooks/useArtifacts.ts` - Added favorite event dispatch
4. `ui/components/Sidebar/FavoritesList.tsx` - Added event listener + extended glass orb wrapper
5. `ui/components/Tabs/Tab.tsx` - Extended glass orb wrapper to documents

## Testing Checklist

- [ ] Click ⭐ on app → automatically appears in Favorites
- [ ] Click ⭐ on document → automatically appears in Favorites
- [ ] Favorites sidebar shows glass orb for both apps and documents
- [ ] Tab bar shows glass orb for both apps and documents
- [ ] Sidebar shows Apps above Artifacts
- [ ] All text says "Artifacts" not "Documents"
- [ ] Glass orbs have correct gradients (blue for apps, purple for documents)

## Notes

- The `documents` tab type remains unchanged internally (backwards compatibility)
- Only user-facing labels changed to "Artifacts"
- The automatic favorite sync uses window events (decoupled architecture)
- Glass orb styling is conditional based on tab/favorite type
- Event-based sync ensures real-time updates without polling
