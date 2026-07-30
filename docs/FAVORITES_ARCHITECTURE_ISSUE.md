# Favorites Architecture Issue

**Date:** 2026-03-12  
**Status:** ⚠️ IDENTIFIED - Needs Fix

---

## Problem

There are **THREE separate favorite storage systems** that are out of sync:

### 1. Documents Favorites
**Location:** `$PAPR_HOME/documents/{docId}/meta.json`  
**Field:** `favorite: boolean`  
**Managed by:** `DocumentService.ts`

```json
{
  "id": "my-doc",
  "title": "My Document",
  "favorite": true,  ← Stored here
  "type": "document",
  ...
}
```

### 2. Apps Favorites
**Location:** `$PAPR_HOME/data/apps.json`  
**Field:** `favorite?: boolean`  
**Managed by:** `AppService.ts`

```json
{
  "id": "my-app-123",
  "title": "My App",
  "favorite": true,  ← Stored here
  "type": "app",
  ...
}
```

### 3. Tabs Favorites (UI State)
**Location:** `~/.paprwork-v2/app-state.db`  
**Table:** `tabs`  
**Field:** `is_favorite INTEGER`  
**Managed by:** `AppStateStorage.ts`

```sql
CREATE TABLE tabs (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,  -- Points to doc/app ID
  is_favorite INTEGER,      ← Stored here
  ...
);
```

---

## The Synchronization Problem

**Current Flow (Broken):**

```
User clicks star on artifact
  ↓
Updates artifact's favorite (Document/App)
  ↓
Dispatches 'papr-favorite-added' event
  ↓
FavoritesList creates/updates tab with isFavorite
  ↓
Saves tab to SQLite
```

**Issues:**

1. **Initial Load:** When app starts, tabs load from SQLite, but artifacts might have different favorite status
2. **Orphaned Tabs:** If you delete an artifact, the tab stays favorited
3. **Missing Tabs:** If you favorite an artifact but close the tab, the favorite is lost
4. **Duplicate State:** Same favorite status stored in 3 places

---

## Why This Happened

This is a **transition architecture** between V1 and V2:

- **V1:** Had documents/apps with favorite flags in their metadata
- **V2:** Introduced tabs system with separate favorite tracking
- **Migration:** Didn't unify the two systems, just added a third

---

## Solution Options

### Option 1: Single Source of Truth (Artifacts)
✅ **Recommended**

Make artifacts (documents/apps) the **only** source of truth for favorites. Tabs derive their favorite status from the artifact.

**Changes:**
1. Remove `is_favorite` from tabs table
2. When loading favorites list, query artifact favorite status
3. When toggling favorite, only update artifact
4. Tabs check artifact favorite status on render

**Pros:**
- Single source of truth
- No sync issues
- Simpler logic

**Cons:**
- Slightly slower (need to lookup artifact for each tab)
- Requires loading all artifacts on startup

### Option 2: Bidirectional Sync
Keep both systems but add proper synchronization.

**Changes:**
1. Keep `is_favorite` in tabs
2. Keep `favorite` in artifacts
3. Add sync logic: when one updates, update the other
4. Add reconciliation on app startup

**Pros:**
- Faster (no lookups)
- Works offline (cached in tabs)

**Cons:**
- More complex
- Can still get out of sync
- Need conflict resolution

### Option 3: Unified Favorites Table
Create a single favorites table that tracks all favorites.

**Changes:**
1. New table: `favorites (entity_id, entity_type, favorited_at)`
2. Remove `favorite` from documents/apps metadata
3. Remove `is_favorite` from tabs
4. Query this table for all favorite checks

**Pros:**
- True single source of truth
- Easy to query all favorites
- No duplication

**Cons:**
- Requires migration of existing data
- Changes artifact structure
- Breaking change

---

## Recommended Implementation

**Use Option 1: Artifacts as Source of Truth**

### Phase 1: Read from Artifacts
1. Change `FavoritesList` to load from artifacts store, not tabs
2. Filter artifacts where `favorite === true`
3. Keep tabs for UI state (which tab is open), not for favorite status

### Phase 2: Remove Tab Favorites
1. Remove `is_favorite` from tabs table schema
2. Remove favorite-related IPC calls that update tabs
3. Only update artifact favorite status

### Phase 3: Fast Path
1. Add `artifactsStore.getFavorites()` helper
2. Cache favorites list in memory
3. Update cache when artifact favorite changes

---

## Implementation Details

### Current Code Locations

**Favorites List:**
- `ui/components/Sidebar/FavoritesList.tsx` - Displays favorites (currently reads from tabs)
- `ui/hooks/useArtifacts.ts` - Manages artifacts + favorites

**Storage:**
- `src/gateway/services/DocumentService.ts` - Documents with `favorite` field
- `src/gateway/services/AppService.ts` - Apps with `favorite` field  
- `src/gateway/services/storage/AppStateStorage.ts` - Tabs with `is_favorite` field

**Events:**
- `papr-favorite-added` - Dispatched when artifact favorited
- `papr-favorite-removed` - Dispatched when artifact unfavorited
- `papr-favorite-removed-from-sidebar` - Dispatched when removed from sidebar

### Migration Path

```typescript
// BEFORE (3 sources of truth)
tabs.find(t => t.isFavorite)  // ❌ Tab favorites
artifact.favorite  // ❌ Artifact favorites
// Two can be out of sync!

// AFTER (1 source of truth)
artifacts.filter(a => a.favorite)  // ✅ Only artifact favorites
// Tabs are just UI state (which tab is open)
```

---

## Testing Plan

1. **Test favorite persistence:**
   - Favorite an artifact
   - Close app
   - Reopen app
   - Verify artifact is still favorited

2. **Test star button:**
   - Click star on artifact card
   - Verify it appears in sidebar immediately
   - Verify it persists after reload

3. **Test drag and drop:**
   - Drag artifact to favorites
   - Verify it's favorited
   - Verify star icon updates on card

4. **Test unfavorite:**
   - Remove from sidebar
   - Verify star icon updates on card
   - Verify it persists after reload

5. **Test delete artifact:**
   - Favorite an artifact
   - Delete the artifact
   - Verify it's removed from favorites
   - Verify no orphaned entries

---

## Impact

**Users affected:** All users with favorites

**Data migration:** 
- Read favorites from artifacts on load
- Populate tabs `is_favorite` from artifacts (one-time sync)
- Eventually remove `is_favorite` column

**Breaking changes:** None (backward compatible)

---

## Next Steps

1. Implement Option 1 (artifacts as source of truth)
2. Add favorites cache in artifacts store
3. Update FavoritesList to read from artifacts
4. Remove tab favorite sync logic
5. Test thoroughly
6. Document new architecture
