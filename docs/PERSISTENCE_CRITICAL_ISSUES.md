# Persistence Architecture - Critical Issues & Fixes

**Date:** 2026-03-07  
**Status:** ⚠️ In Progress

## Critical Issues Found

### Issue 1: Onboarding Not Loading
**Problem:** SQLite has correct data (`onboardingStep1Completed=true`) but localStorage shows `false` after app restart.

**Root Cause:** Race condition - components read localStorage before SQLite load completes.

**Fix Applied:**
- Block app render until SQLite loads (`papr-sqlite-loaded` event)
- `useAppStatePersistence` populates localStorage from SQLite
- Only then render components

**Status:** ✅ Architecture fixed, but still testing

### Issue 2: Duplicate/Corrupt Document Tabs
**Problem:** Document tabs saved with wrong entity IDs:
- Correct: `entity_id = "paprwork-v2-slack-..."`  
- Wrong: `entity_id = "document-paprwork-v2-slack-..."` (double prefix)

**Root Cause:** ✅ **FOUND AND FIXED**

The bug was in `FavoritesList.tsx` line 66:
```typescript
// WRONG - uses tab ID (which includes type prefix)
createTab(tabType, fav.id, fav.title, ...)

// RIGHT - uses entityId (without type prefix)
createTab(existingTab.type, existingTab.entityId, fav.title, ...)
```

When opening a favorite:
1. Favorite stores tab ID: `document-paprwork-v2-slack-...`
2. Old code passed this to `createTab()` as entityId
3. `createTab()` adds type prefix: `document-` + `document-paprwork-v2-...`  
4. Result: `document-document-paprwork-v2-...` ❌

**Fix Applied:** Now lookup the actual tab and use its `entityId` instead of tab `id`.

**Will it happen again?** ✅ **NO** - The bug is fixed. Opening favorites now uses correct entityId.

### Issue 3: Merged Tabs Not Persisting
**Problem:** When tabs are merged (split view), closing and reopening loses the child tab.

**Root Cause:** `childTabIds` not reconstructed from `parentTabId` relationships.

**Fix Applied:** ✅ Build parent-child relationships on load

## Data Flow Architecture

### On Startup (Load)
```
1. App.tsx mounts
2. useAppStatePersistence() starts loading
3. Load tabs from SQLite → Build parent-child relationships
4. Load app_state from SQLite → Populate localStorage
5. Dispatch 'papr-sqlite-loaded' event
6. App.tsx renders (components now see populated localStorage)
7. OnboardingCard reads from localStorage (correct data)
```

### On Change (Save)
```
User Action (e.g., completes onboarding step)
  ↓
Component updates localStorage
  ↓
Component dispatches 'papr-onboarding-changed' event
  ↓
useAppStatePersistence listens for event
  ↓
Immediately saves to SQLite (no debounce)
  ↓
Next startup → loads from SQLite ✓
```

### Tab Creation Flow
```
User creates tab
  ↓
Generate tab ID: `${type}-${entityId}`
  ↓
Store in Zustand: { id, type, entityId, ... }
  ↓
Debounced save to SQLite (1s)
  ↓
SQLite stores: id, type, entity_id, ...
  ↓
On load: Reconstruct from SQLite
```

## Protection Mechanisms Needed

### 1. Tab ID Validation
```typescript
function validateTabId(id: string, entityId: string, type: string): boolean {
  // Tab ID should be: type-entityId
  const expected = `${type}-${entityId}`;
  
  // Check for double prefix
  if (entityId.startsWith(type)) {
    console.error(`[Validation] Entity ID has duplicate prefix: ${entityId}`);
    return false;
  }
  
  if (id !== expected) {
    console.error(`[Validation] Tab ID mismatch. Expected: ${expected}, Got: ${id}`);
    return false;
  }
  
  return true;
}
```

### 2. Database Cleanup on Startup
```typescript
function cleanupCorruptTabs() {
  // Remove tabs where entity_id starts with the type prefix
  db.prepare(`
    DELETE FROM tabs 
    WHERE entity_id LIKE type || '-%'
  `).run();
  
  // Remove duplicate tabs (keep newest)
  db.prepare(`
    DELETE FROM tabs 
    WHERE rowid NOT IN (
      SELECT MAX(rowid) 
      FROM tabs 
      GROUP BY entity_id, type
    )
  `).run();
}
```

### 3. Persistence Verification
```typescript
// After save, verify data was actually written
async function verifyPersistence(key: string, expectedValue: any) {
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const actual = await loadFromSQLite(key);
  if (actual !== expectedValue) {
    console.error(`[Verification] Persistence failed for ${key}. Expected: ${expectedValue}, Got: ${actual}`);
    // Retry save
    await saveToSQLite(key, expectedValue);
  }
}
```

### 4. Graceful Degradation
```typescript
// If SQLite fails, don't crash - use in-memory state
try {
  await loadFromSQLite();
} catch (error) {
  console.error('[Persistence] SQLite load failed, using defaults:', error);
  setDefaults();
  setSqliteLoaded(true); // Allow app to continue
}
```

## Testing Checklist

### Onboarding Persistence
- [ ] Complete step 1 → close app → reopen → step 1 still completed
- [ ] Complete all steps → auto-dismiss → close app → reopen → stays dismissed
- [ ] Check console logs show: "Onboarding state loaded: { step1: true }"
- [ ] Check localStorage after load: `papr-onboarding-step1` = `"true"`

### Tab Persistence
- [ ] Create document tab → close app → reopen → document shows correctly
- [ ] Merge tabs (split view) → close app → reopen → both panes show
- [ ] Favorite a tab → close app → reopen → favorite persists
- [ ] Switch tabs → close app → reopen → active tab persists

### Data Integrity
- [ ] No duplicate tabs in database
- [ ] No entity IDs with type prefixes
- [ ] Parent-child relationships correct
- [ ] All tabs have valid entity IDs

## Debugging Commands

```bash
# Check all tabs
sqlite3 ~/.paprwork-v2/app-state.db "SELECT id, type, entity_id, title, parent_tab_id FROM tabs;"

# Check onboarding state
sqlite3 ~/.paprwork-v2/app-state.db "SELECT key, value FROM app_state WHERE key LIKE '%onboarding%';"

# Find corrupt tabs (double prefix)
sqlite3 ~/.paprwork-v2/app-state.db "SELECT id, entity_id FROM tabs WHERE entity_id LIKE type || '-%';"

# Check for duplicates
sqlite3 ~/.paprwork-v2/app-state.db "SELECT entity_id, type, COUNT(*) as cnt FROM tabs GROUP BY entity_id, type HAVING cnt > 1;"

# Clean up
sqlite3 ~/.paprwork-v2/app-state.db "DELETE FROM tabs WHERE id LIKE 'document-document-%';"
```

## Files to Review/Fix

1. **Tab Creation Logic** - Where tabs get their IDs
   - `ui/hooks/useTabs.ts` (or wherever `createTab` is)
   - Check for double prefix bugs

2. **Persistence Save** - Where tabs are saved
   - `ui/hooks/useAppStatePersistence.ts`
   - Add validation before save

3. **Persistence Load** - Where tabs are loaded
   - `ui/hooks/useAppStatePersistence.ts`
   - Already fixed parent-child relationships ✓
   - Need to add corruption detection

4. **OnboardingCard** - Where onboarding state is managed
   - `ui/components/Sidebar/OnboardingCard.tsx`
   - Already dispatches custom event ✓
   - Need to verify event listener works

## Next Steps

1. **Immediate:** Add detailed logging to track onboarding load
2. **Short-term:** Add tab ID validation in createTab()
3. **Short-term:** Add database cleanup on startup
4. **Medium-term:** Add persistence verification tests
5. **Long-term:** Consider migrations system for schema changes
