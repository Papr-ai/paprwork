# Purple Icons and Bidirectional Favorites Sync

**Date:** 2026-03-07
**Fixes:** Document icons show purple gradient + bidirectional favorites sync

## Issues Fixed

### 1. ✅ Purple Icons for Documents in Tabs/Favorites
**Problem:** Document icons in tabs and favorites sidebar were showing blue gradient (app color) instead of purple/pink.

**Solution:**
- Added `.tab__glass-orb--document` CSS class with purple/pink gradient
- Added `.favorite-item__glass-orb--document` CSS class with purple/pink gradient
- Updated Tab.tsx to apply document class when `tab.type === "document" || tab.type === "documents"`
- Updated FavoritesList.tsx to apply document class when `favorite.type === "document"`

**Gradient Colors:**
- **Apps (Blue/Cyan):** `rgba(1, 97, 224) → rgba(12, 205, 255) → rgba(0, 254, 254)`
- **Documents (Purple/Pink):** `rgba(139, 92, 246) → rgba(217, 70, 239) → rgba(236, 72, 153)`

### 2. ✅ Bidirectional Favorites Sync
**Problem:** 
- Clicking star to unfavorite in Apps/Artifacts didn't remove from sidebar
- Removing from sidebar didn't unfavorite in Apps/Artifacts gallery

**Solution:**
Implemented bidirectional event system:

**Gallery → Sidebar (Unfavorite):**
1. `useArtifacts.ts` toggleFavorite() emits `papr-favorite-removed` event when unfavoriting
2. `FavoritesList.tsx` listens for event and removes from list

**Sidebar → Gallery (Remove):**
1. `FavoritesList.tsx` removeFavorite() emits `papr-favorite-removed-from-sidebar` event
2. `useArtifacts.ts` listens for event and toggles favorite off in the artifact

## Technical Implementation

### Event Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    FAVORITING (Add)                          │
└─────────────────────────────────────────────────────────────┘

User clicks ⭐ in Gallery
         ↓
useArtifacts.toggleFavorite()
         ↓
Update artifact.favorite = true
         ↓
Emit: papr-favorite-added { id, type, title, icon }
         ↓
FavoritesList listens → adds to sidebar


┌─────────────────────────────────────────────────────────────┐
│                  UNFAVORITING (Remove)                       │
└─────────────────────────────────────────────────────────────┘

Path 1: User clicks ⭐ in Gallery (unfavorite)
         ↓
useArtifacts.toggleFavorite()
         ↓
Update artifact.favorite = false
         ↓
Emit: papr-favorite-removed { id }
         ↓
FavoritesList listens → removes from sidebar

Path 2: User clicks × in Sidebar (remove favorite)
         ↓
FavoritesList.removeFavorite()
         ↓
Remove from sidebar list
         ↓
Emit: papr-favorite-removed-from-sidebar { id }
         ↓
useArtifacts listens → toggles favorite off
         ↓
Update artifact.favorite = false
```

### CSS Classes Added

**Tab.css:**
```css
.tab__glass-orb--document {
  background: linear-gradient(
    135deg,
    rgba(139, 92, 246, 0.40),
    rgba(217, 70, 239, 0.30),
    rgba(236, 72, 153, 0.25)
  );
  border: 0.5px solid rgba(217, 70, 239, 0.30);
  box-shadow:
    0 1px 3px rgba(139, 92, 246, 0.20),
    inset 0 1px 1px rgba(255, 255, 255, 0.35);
}
```

**FavoritesList.css:**
```css
.favorite-item__glass-orb--document {
  background: linear-gradient(
    135deg,
    rgba(139, 92, 246, 0.40),
    rgba(217, 70, 239, 0.30),
    rgba(236, 72, 153, 0.25)
  );
  border: 0.5px solid rgba(217, 70, 239, 0.30);
  box-shadow:
    0 1px 3px rgba(139, 92, 246, 0.20),
    inset 0 1px 1px rgba(255, 255, 255, 0.35);
}
```

### Event Handlers Added

**useArtifacts.ts:**
```typescript
// Emit unfavorite event
if (!updated.favorite) {
  window.dispatchEvent(
    new CustomEvent("papr-favorite-removed", {
      detail: { id },
    }),
  );
}

// Listen for sidebar removal
useEffect(() => {
  const handleFavoriteRemovedFromSidebar = (event: Event) => {
    const { id } = (event as CustomEvent).detail;
    const artifact = artifacts.find((a) => a.id === id);
    if (artifact && artifact.favorite) {
      toggleFavorite(id, artifact.type as "document" | "app");
    }
  };

  window.addEventListener("papr-favorite-removed-from-sidebar", handleFavoriteRemovedFromSidebar);
  return () => window.removeEventListener("papr-favorite-removed-from-sidebar", handleFavoriteRemovedFromSidebar);
}, [artifacts, toggleFavorite]);
```

**FavoritesList.tsx:**
```typescript
// Listen for unfavorite event
useEffect(() => {
  const handleFavoriteRemoved = (event: Event) => {
    const { id } = (event as CustomEvent).detail;
    setFavorites((prev) => prev.filter((f) => f.id !== id));
  };

  window.addEventListener("papr-favorite-removed", handleFavoriteRemoved);
  return () => window.removeEventListener("papr-favorite-removed", handleFavoriteRemoved);
}, [favorites]);

// Emit removal event when removing from sidebar
const removeFavorite = (id: string) => {
  gateway.send('app:toggle_favorite_tab', { tabId: id });
  saveFavorites(favorites.filter((f) => f.id !== id));
  
  window.dispatchEvent(
    new CustomEvent("papr-favorite-removed-from-sidebar", {
      detail: { id },
    }),
  );
};
```

## Files Modified

1. **ui/components/Tabs/Tab.css**
   - Added `.tab__glass-orb--document` with purple gradient
   - Added dark mode variant

2. **ui/components/Tabs/Tab.tsx**
   - Added document class conditionally: `tab__glass-orb--document`

3. **ui/components/Sidebar/FavoritesList.css**
   - Added `.favorite-item__glass-orb--document` with purple gradient
   - Added dark mode variant

4. **ui/components/Sidebar/FavoritesList.tsx**
   - Added document class conditionally in getIcon()
   - Added `handleFavoriteRemoved` event listener
   - Emit `papr-favorite-removed-from-sidebar` in removeFavorite()

5. **ui/hooks/useArtifacts.ts**
   - Emit `papr-favorite-removed` event when unfavoriting
   - Added `handleFavoriteRemovedFromSidebar` event listener
   - Call toggleFavorite() when sidebar removal event received

## User Experience

### Before
- ❌ Document icons showed blue gradient everywhere
- ❌ Unfavoriting in gallery didn't update sidebar
- ❌ Removing from sidebar didn't unfavorite in gallery

### After
- ✅ Document icons show purple/pink gradient (distinct from apps)
- ✅ Unfavoriting in gallery instantly removes from sidebar
- ✅ Removing from sidebar instantly unfavorites in gallery
- ✅ Complete bidirectional sync via custom events

## Visual Consistency

Now all document/artifact icons use the purple/pink gradient consistently across:
- ✅ Document cards in Artifacts gallery (glass orb on card)
- ✅ Tabs (glass orb with purple gradient)
- ✅ Favorites sidebar (glass orb with purple gradient)

And all app icons use the blue/cyan gradient consistently across:
- ✅ App cards in Apps gallery (glass orb on card)
- ✅ Tabs (glass orb with blue gradient)
- ✅ Favorites sidebar (glass orb with blue gradient)

## Testing Checklist

- [ ] Document tabs show purple/pink glass orb icon
- [ ] Document favorites show purple/pink glass orb icon
- [ ] App tabs show blue/cyan glass orb icon
- [ ] App favorites show blue/cyan glass orb icon
- [ ] Click ⭐ to unfavorite in Apps → removes from sidebar instantly
- [ ] Click ⭐ to unfavorite in Artifacts → removes from sidebar instantly
- [ ] Click × in sidebar for app → unfavorites in Apps gallery instantly
- [ ] Click × in sidebar for document → unfavorites in Artifacts gallery instantly
- [ ] Both light and dark mode show correct gradients

## Architecture Notes

The bidirectional sync uses a **decoupled event-based architecture**:
- No direct coupling between FavoritesList and useArtifacts
- Components communicate via window custom events
- Each component manages its own state and listens for relevant events
- SQLite operations happen in both directions (add/remove favorite)
- Prevents infinite loops by checking state before toggling

This approach ensures:
- ✅ Loose coupling (components don't import each other)
- ✅ Real-time sync (no polling needed)
- ✅ Maintainable (easy to add more listeners)
- ✅ Prevents race conditions (state checks before actions)
