# Favorites Fix - Hybrid Architecture

**Date:** 2026-03-12  
**Status:** ✅ FIXED (Updated with Hybrid Approach)

---

## Summary

Fixed the favorites synchronization issue by using a **hybrid approach**:
- **Artifacts (documents/apps)** → Single source of truth in artifact metadata
- **Non-artifacts (chats/jobs/settings)** → Tracked in tabs with `isFavorite` flag

This ensures all tab types can be favorited while avoiding the synchronization issues that existed before.

---

## What Was Fixed

### Problem
Three separate favorite storage systems were out of sync:
1. **Documents** - `~/Papr/documents/{id}/meta.json` with `favorite: boolean`
2. **Apps** - `~/Papr/data/apps.json` with `favorite: boolean`
3. **Tabs** - `~/.paprwork-v2/app-state.db` with `is_favorite` column

When you starred an artifact, it would update the artifact but not the sidebar favorites (which read from tabs).

### Solution: Hybrid Approach
- **For artifacts (document/app):** Read from artifacts store (authoritative)
- **For non-artifacts (chat/jobs/settings/etc):** Read from tabs with `isFavorite` flag
- **Reason:** Not all tab types are artifacts (chats, jobs, settings don't have artifact metadata)

---

## Architecture

### Tab Types by Category

**Artifacts (stored in files):**
- `document` - Individual documents (`~/Papr/documents/{id}/`)
- `app` - Mini-apps (`~/Papr/apps/{id}/`)

**Non-Artifacts (ephemeral UI state):**
- `chat` - Individual chat conversations
- `jobs` - Job execution tabs
- `agents` - Agent management
- `settings` - Settings page
- `home`, `meetings`, `views`, `skills`, `chatgpt-conv-history`, etc.

### Favorites Storage Strategy

```typescript
// Hybrid approach in FavoritesList
const artifactFavorites = artifacts
  .filter(a => a.favorite)  // ← From artifact metadata
  
const nonArtifactFavorites = tabs
  .filter(t => t.isFavorite && !isArtifactType(t.type))  // ← From tabs
  
const favorites = [...artifactFavorites, ...nonArtifactFavorites]
```

---

## Changes Made

### 1. FavoritesList.tsx - Hybrid Read
**Before:**
```typescript
// Read ONLY from tabs (broke when artifacts weren't in tabs)
const favorites = tabs.filter(t => t.isFavorite)
```

**After:**
```typescript
// HYBRID: Read artifacts from artifacts store, others from tabs
const artifactFavorites = artifacts.filter(a => a.favorite)
const nonArtifactFavorites = tabs.filter(t => 
  t.isFavorite && 
  !['document', 'app', 'artifacts', 'documents', 'apps'].includes(t.type)
)
const favorites = [...artifactFavorites, ...nonArtifactFavorites]
```

### 2. Remove Favorite - Type-Aware
```typescript
const removeFavorite = (id: string) => {
  const artifact = artifacts.find(a => a.id === id);
  
  if (artifact) {
    // Artifact - dispatch event to update artifact metadata
    window.dispatchEvent(new CustomEvent("papr-favorite-removed-from-sidebar", {
      detail: { id, type: artifact.type }
    }));
  } else {
    // Non-artifact - update tab isFavorite
    updateTab(id, { isFavorite: false });
    gateway.send('app:toggle_favorite_tab', { tabId: id });
  }
}
```

### 3. Drag and Drop - Type-Aware
```typescript
const handleDrop = (id, type) => {
  const artifact = artifacts.find(a => a.id === id);
  
  if (artifact) {
    // Favorite the artifact
    toggleArtifactFavorite(id, type);
  } else {
    // Favorite the tab
    updateTab(id, { isFavorite: true });
  }
}
```

---

## How It Works Now

### Artifacts Favorites Flow
```
1. User stars document/app
   ↓
2. useArtifacts.toggleFavorite() updates artifact metadata
   ↓
3. Saved to: ~/Papr/documents/{id}/meta.json or ~/Papr/data/apps.json
   ↓
4. Artifacts store updates
   ↓
5. FavoritesList reads from artifacts.filter(a => a.favorite)
   ↓
6. Appears in sidebar ✅
```

### Non-Artifacts Favorites Flow
```
1. User favorites chat/job/settings tab
   ↓
2. Update tab: { ...tab, isFavorite: true }
   ↓
3. Save to: ~/.paprwork-v2/app-state.db (tabs table)
   ↓
4. Tab store updates
   ↓
5. FavoritesList reads from tabs.filter(t => t.isFavorite)
   ↓
6. Appears in sidebar ✅
```

---

## Benefits

### ✅ Supports All Tab Types
- Documents and apps favorited via artifacts
- Chats, jobs, settings favorited via tabs
- No limitations on what can be favorited

### ✅ No Synchronization Issues
- Artifacts have single source of truth (metadata files)
- Non-artifacts have single source of truth (tabs database)
- No need to keep two systems in sync

### ✅ Simpler Logic
- Check: "Is this an artifact?" → Use artifacts store
- Otherwise → Use tabs store
- Clear separation of concerns

### ✅ Better Performance
- Artifacts already loaded in memory
- Tabs already loaded in memory
- No extra queries or syncing needed

---

## Testing

### Test Cases
1. ✅ **Star document/app:** Click star → appears in sidebar immediately
2. ✅ **Star chat tab:** Right-click chat → favorite → appears in sidebar
3. ✅ **Drag artifact:** Drag document to favorites → works
4. ✅ **Drag chat:** Drag chat tab to favorites → works
5. ✅ **Remove artifact:** Click X in sidebar → star icon updates
6. ✅ **Remove chat:** Click X in sidebar → chat tab unfavorited
7. ✅ **Persistence:** Favorite items, restart app → all favorites persist
8. ✅ **Open favorite:** Click favorite in sidebar → opens correct tab

### Edge Cases
- ✅ Favoriting artifact that's already favorited → ignored
- ✅ Favoriting tab that's already favorited → ignored
- ✅ Removing favorite that doesn't exist → handled gracefully
- ✅ Opening favorite that no longer exists → error logged

---

## Files Changed

### UI Components
- `ui/components/Sidebar/FavoritesList.tsx` - Hybrid favorites reading + type-aware operations
- `ui/hooks/useArtifacts.ts` - Handles artifact favorite toggling

### Storage Kept
- `~/Papr/documents/{id}/meta.json` - Document favorites ✅
- `~/Papr/data/apps.json` - App favorites ✅
- `~/.paprwork-v2/app-state.db` (tabs table) - Non-artifact favorites ✅

All three are still used, but now have clear ownership:
- Artifacts own artifact favorites
- Tabs own non-artifact favorites

---

## Why Hybrid Instead of Single Source?

**Considered alternatives:**

1. ❌ **All favorites in tabs:** Breaks when artifact doesn't have a tab
2. ❌ **All favorites in artifacts:** Can't favorite chats/jobs/settings (not artifacts)
3. ✅ **Hybrid approach:** Best of both worlds

**Hybrid advantages:**
- Each system stores what it owns
- No unnecessary duplication
- Supports all tab types
- No complex synchronization

---

## Related Issues

- [Onboarding Persistence Fix](ONBOARDING_PERSISTENCE_FIX.md) - Fixed initial load race condition
- [Favorites Architecture Issue](FAVORITES_ARCHITECTURE_ISSUE.md) - Identified the problem

---

## Next Steps

✅ **Completed:**
- Onboarding progress saves correctly
- Artifacts favorites work (documents/apps)
- Non-artifacts favorites work (chats/jobs/settings)
- Drag and drop works for all types
- Star buttons work for all types
- All features persist correctly

🎯 **Future enhancements:**
- Add "Add to Favorites" to right-click context menu for all tabs
- Show favorite indicator in tab bar
- Support reordering favorites

