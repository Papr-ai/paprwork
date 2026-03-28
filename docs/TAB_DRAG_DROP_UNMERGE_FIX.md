# Tab Drag-and-Drop & Unmerge Position Fix

**Date:** 2026-03-27  
**Issue:** Tab drag-and-drop for reordering didn't work, and unmerging tabs placed the child tab in a random location instead of next to its parent.

---

## Problems Identified

### Problem 1: Tab Reordering Failed

**Symptom:** Dragging a tab to reorder it didn't work; only merging (dropping on top) worked.

**Root Cause:** Index mismatch between visible tabs and full tabs array.

```typescript
// TabBar.tsx - BEFORE (broken)
getVisibleTabs().map((tab, index) => {
  return (
    <Tab
      tabIndex={index}  // ❌ index from visible tabs (standalone + parent only)
      // ...
    />
  );
})

// Tab.tsx - handleDrop uses tabIndex with moveTab()
moveTab(fromIndex, toIndex);  // ❌ moveTab expects indices from FULL tabs array
```

**The Issue:**
- `getVisibleTabs()` filters out child tabs (merged tabs in split view)
- `tabIndex` prop passed to Tab component was from the filtered visible array (0, 1, 2...)
- `moveTab(fromIndex, toIndex)` operates on the full `tabs` array (which includes child tabs)
- Example: If you have 5 total tabs (3 visible, 2 children), visible indices are 0, 1, 2 but actual indices might be 0, 2, 4
- Dragging "visible tab 2" would try to move "actual tab 2" → wrong tab!

### Problem 2: Unmerge Placed Child Tab Randomly

**Symptom:** Double-clicking a merged tab to unmerge places the 2nd tab at a random location instead of next to the 1st tab.

**Root Cause:** `promoteToStandalone` only changed tab properties in-place without repositioning the tab in the array.

```typescript
// tabStore.ts - BEFORE (broken)
promoteToStandalone: (tabId) => {
  // ...
  set((state) => ({
    tabs: state.tabs.map((t) => {
      if (t.id === tabId) {
        return {
          ...t,
          parentTabId: null,
          displayMode: "standalone",
          position: undefined,
        };
      }
      return t;
    }),
  }));
  // ❌ Tab remains wherever it was in the array (could be anywhere!)
},
```

**The Issue:**
- Child tabs could be anywhere in the `tabs` array (they were added when created, not when merged)
- When promoted to standalone, they stayed in their current position
- If child was at index 8 and parent at index 2, unmerging left them far apart

---

## Solutions

### Fix 1: Pass Actual Tab Index (Not Visible Index)

**File:** `ui/components/Tabs/TabBar.tsx`

```typescript
// AFTER (fixed)
getVisibleTabs().map((tab, visibleIndex) => {
  // CRITICAL: Pass the actual index from the full tabs array
  const actualTabIndex = tabs.findIndex((t) => t.id === tab.id);

  return (
    <Tab
      tabIndex={actualTabIndex}  // ✅ Now uses correct index from full tabs array
      // ...
    />
  );
})
```

**Why This Works:**
- `actualTabIndex` is the tab's true position in the full `tabs` array
- `moveTab(fromIndex, toIndex)` now receives correct indices
- Drag-and-drop reordering works correctly

### Fix 2: Move Promoted Tab Next to Parent

**File:** `ui/stores/tabStore.ts`

```typescript
// AFTER (fixed)
promoteToStandalone: (tabId) => {
  const tab = get().getTab(tabId);
  if (!tab) return;

  const parentId = tab.parentTabId;

  // Remove from parent
  if (parentId) {
    get().removeChild(parentId, tabId);
  }

  set((state) => {
    const tabs = state.tabs.map((t) => {
      if (t.id === tabId) {
        return {
          ...t,
          parentTabId: null,
          displayMode: "standalone" as DisplayMode,
          position: undefined,
        };
      }
      return t;
    });

    // ✅ NEW: If the tab had a parent, move it to be adjacent
    if (parentId) {
      const currentIndex = tabs.findIndex((t) => t.id === tabId);
      const parentIndex = tabs.findIndex((t) => t.id === parentId);

      if (currentIndex !== -1 && parentIndex !== -1) {
        // Remove from current position
        const [movedTab] = tabs.splice(currentIndex, 1);
        // Insert right after parent
        const insertIndex =
          currentIndex < parentIndex ? parentIndex : parentIndex + 1;
        tabs.splice(insertIndex, 0, movedTab);
      }
    }

    return { tabs };
  });
},
```

**Why This Works:**
- After promoting to standalone, we find both the child and parent indices
- We splice the child out of its current position
- We insert it right after the parent
- The `insertIndex` calculation accounts for the splice affecting indices

**Edge Case Handling:**
- `currentIndex < parentIndex`: Child was before parent, so after removal, parent index stays the same → insert at `parentIndex`
- `currentIndex > parentIndex`: Child was after parent, so after removal, parent index shifts → insert at `parentIndex + 1`

---

## Testing

### Test Case 1: Tab Reordering
1. Create 3-4 tabs
2. Drag a tab to the left/right (not on top)
3. ✅ Tab should move to the new position

### Test Case 2: Tab Merging
1. Create 2 tabs
2. Drag one tab on top of another
3. ✅ Should create split view with both tabs side-by-side

### Test Case 3: Unmerging Tabs
1. Create split view (merge two tabs)
2. Double-click the merged tab in the tab bar
3. ✅ Both tabs should appear as separate tabs, next to each other

### Test Case 4: Reordering with Merged Tabs
1. Create 5 tabs, merge tab 2+3
2. Drag tab 1 to the right
3. ✅ Should reorder correctly despite having merged tabs

---

## Impact

**Before:**
- ❌ Tab reordering broken (only merge worked)
- ❌ Unmerge placed tabs randomly
- ❌ Confusing UX, tabs appeared "lost"

**After:**
- ✅ Tab reordering works correctly
- ✅ Unmerge places tabs adjacent (predictable)
- ✅ Intuitive tab management UX

---

## Related Files

- `ui/components/Tabs/TabBar.tsx` - Tab rendering and index calculation
- `ui/components/Tabs/Tab.tsx` - Drag-and-drop logic
- `ui/stores/tabStore.ts` - Tab state management and operations

---

## Prevention

**Key Lesson:** When working with filtered arrays for UI display, always pass the original array indices to state mutation functions, not the filtered indices.

**Pattern to Follow:**
```typescript
// ❌ WRONG
filteredItems.map((item, index) => {
  <Component onAction={() => mutate(index)} />
})

// ✅ CORRECT
filteredItems.map((item) => {
  const actualIndex = allItems.findIndex(i => i.id === item.id);
  <Component onAction={() => mutate(actualIndex)} />
})
```
