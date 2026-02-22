# Favorites Auto-Sync Implementation

**Date:** 2026-02-22  
**Component:** `ui/components/Sidebar/FavoritesList.tsx`

## Problem

When app icons are updated in app metadata, favorites in the left sidebar weren't automatically updating to show the new icon. Users had to manually remove and re-add favorites to see icon changes.

## Solution

Implemented automatic syncing of favorites with current artifact data (apps and documents).

### Changes Made

1. **Added artifacts store connection:**
   - Import `useArtifactsStore` to access current artifact data
   - Subscribe to artifact changes

2. **Auto-sync effect:**
   ```typescript
   useEffect(() => {
     if (favorites.length === 0 || artifacts.length === 0) return;

     let updated = false;
     const synced = favorites.map((fav) => {
       // Only sync apps and documents (skip chats)
       if (fav.type !== "app" && fav.type !== "document") return fav;

       const artifact = artifacts.find((a) => a.id === fav.id && a.type === fav.type);
       if (!artifact) return fav;

       // Check if icon or title changed
       if (artifact.icon !== fav.icon || artifact.title !== fav.title) {
         updated = true;
         console.log(`[FavoritesList] Auto-syncing favorite: ${fav.id}`);
         return {
           ...fav,
           title: artifact.title,
           icon: artifact.icon,
         };
       }

       return fav;
     });

     if (updated) {
       setFavorites(synced);
       localStorage.setItem("paprwork-favorites", JSON.stringify(synced));
     }
   }, [artifacts, favorites]);
   ```

3. **Drag-and-drop update behavior:**
   - Changed from "skip duplicates" to "update existing"
   - When dragging a tab to favorites that already exists, it updates the icon/title

## Behavior

### Automatic Sync
- **Trigger:** Whenever artifacts are loaded or updated
- **What syncs:** App and document icons and titles
- **Source of truth:** Current artifact metadata from `artifactsStore`
- **Storage:** Updates localStorage automatically

### Manual Update
- **Drag existing favorite to favorites section again** → Updates icon/title

### What's Synced
✅ App icons  
✅ App titles  
✅ Document titles  
❌ Chat data (not synced, no central store)

## Benefits

1. **Zero user intervention** - Icons update automatically
2. **Single source of truth** - Artifact metadata is authoritative
3. **Consistent UX** - Tabs and favorites always match
4. **Rename support** - App renames automatically reflect in favorites

## Testing

To test the auto-sync:

1. Add an app to favorites (with or without icon)
2. Update the app's icon via `app:update` message
3. Favorites should automatically update to show the new icon
4. Check console for: `[FavoritesList] Auto-syncing favorite: {id}`

## Technical Notes

- **Performance:** Only runs when artifacts or favorites change
- **Selective sync:** Only syncs apps and documents (not chats)
- **Non-destructive:** Favorites not found in artifacts remain unchanged
- **Logging:** Console logs when auto-sync occurs for debugging

## Related Files

- `ui/components/Sidebar/FavoritesList.tsx` - Main implementation
- `ui/stores/artifactsStore.ts` - Source of artifact data
- `ui/hooks/useArtifacts.ts` - Artifact loading logic
- `src/gateway/services/AppService.ts` - App metadata updates
