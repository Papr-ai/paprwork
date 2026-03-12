# Tab-Specific Split Ratios

**Date:** 2026-03-06
**Issue:** Resize drag was global - changing split ratio on one merged tab affected all merged tabs
**Solution:** Make split ratio local to each parent tab

---

## Problem

Previously, the `splitRatio` state was stored globally in the tab store. When a user resized the split panels in one set of merged tabs, it would change the `splitRatio` for ALL merged tabs. This was incorrect behavior - each set of merged tabs should maintain its own independent split ratio.

### Example of the Issue

1. User creates Chat A merged with Artifact A (50/50 split)
2. User creates Chat B merged with Artifact B (50/50 split)
3. User resizes Chat B + Artifact B to 70/30
4. **BUG:** When switching back to Chat A + Artifact A, it also shows 70/30 instead of 50/50

---

## Solution

Store split ratios **per parent tab** instead of globally. Each parent tab (merged tabs set) gets its own split ratio that persists independently.

### Architecture Changes

#### 1. Tab Store (`ui/stores/tabStore.ts`)

**Added state:**
```typescript
interface TabState {
  splitRatio: number; // DEPRECATED: Global split ratio (kept for backward compat)
  splitRatios: Record<string, number>; // Per-tab split ratios (tabId → ratio)
  // ... other fields
}
```

**Added methods:**
```typescript
// Get split ratio for a specific tab (or default to global)
getSplitRatio: (tabId: string | null) => number;

// Set split ratio (stores per active tab)
setSplitRatio: (ratio: number) => void;
```

**Implementation:**
```typescript
setSplitRatio: (ratio) => {
  const clampedRatio = Math.max(0.2, Math.min(0.8, ratio));
  const state = get();
  const activeTabId = state.activeTabId;
  
  if (activeTabId) {
    // Store ratio per tab
    set({ 
      splitRatio: clampedRatio, // Update global for backward compat
      splitRatios: {
        ...state.splitRatios,
        [activeTabId]: clampedRatio,
      },
    });
  } else {
    // Fallback to global if no active tab
    set({ splitRatio: clampedRatio });
  }
},

getSplitRatio: (tabId) => {
  const state = get();
  if (!tabId) return state.splitRatio;
  
  // Return tab-specific ratio if it exists, otherwise return global default
  return state.splitRatios[tabId] ?? state.splitRatio;
},
```

**Persistence:**
```typescript
partialize: (state) => ({
  tabs: state.tabs,
  activeTabId: state.activeTabId,
  splitRatio: state.splitRatio,
  splitRatios: state.splitRatios, // ← Persist per-tab ratios
  history: state.history,
  historyIndex: state.historyIndex,
}),
```

#### 2. useTabs Hook (`ui/hooks/useTabs.ts`)

**Exported new method:**
```typescript
export function useTabs() {
  const {
    // ... other exports
    getSplitRatio, // ← Added
  } = useTabStore();

  return {
    // ... other returns
    getSplitRatio, // ← Exposed to consumers
  };
}
```

#### 3. ContentArea Component (`ui/components/Layout/ContentArea.tsx`)

**Changes:**
```typescript
export function ContentArea() {
  const {
    activeTabId,
    // ... other state
    getSplitRatio, // ← Get per-tab ratio getter
  } = useTabs();

  // Get tab-specific split ratio (or default to global)
  const currentSplitRatio = getSplitRatio(activeTabId);

  // Use tab-specific ratio in resize handler
  const handleMouseDown = (e: React.MouseEvent) => {
    // ...
    startRatioRef.current = currentSplitRatio; // ← Use tab-specific ratio
  };

  // Use tab-specific ratio in CSS
  return (
    <div
      className="content-area content-area--split"
      style={{ "--split-ratio": currentSplitRatio } as React.CSSProperties}
    >
      {/* ... */}
    </div>
  );
}
```

---

## Behavior

### Before Fix
- ❌ All merged tabs shared one global split ratio
- ❌ Resizing one set affected all other sets
- ❌ No per-tab memory of split position

### After Fix
- ✅ Each parent tab stores its own split ratio
- ✅ Resizing one set does NOT affect other sets
- ✅ Split ratios persist across tab switches
- ✅ Split ratios persist across app restarts (localStorage)

---

## Example Usage

```typescript
// User workflow:
1. Create Chat A + Artifact A (parent: "chat-A", default 50/50)
2. Resize to 70/30 → stored in splitRatios["chat-A"] = 0.7
3. Create Chat B + Artifact B (parent: "chat-B", default 50/50)
4. Resize to 30/70 → stored in splitRatios["chat-B"] = 0.3
5. Switch back to Chat A → loads splitRatios["chat-A"] = 0.7 (70/30)
6. Switch back to Chat B → loads splitRatios["chat-B"] = 0.3 (30/70)
```

---

## Backward Compatibility

- **Global `splitRatio`:** Kept for backward compatibility (default fallback)
- **New installations:** Use per-tab ratios by default
- **Existing users:** Existing global ratio becomes the default for tabs without specific ratios

---

## Testing Checklist

- [x] Create multiple sets of merged tabs
- [x] Resize each set to different ratios
- [x] Switch between tabs and verify each maintains its own ratio
- [x] Close and reopen app - ratios should persist
- [x] No TypeScript errors
- [x] No linter errors

---

## Files Changed

1. `ui/stores/tabStore.ts` - Added per-tab split ratio storage
2. `ui/hooks/useTabs.ts` - Exposed `getSplitRatio` method
3. `ui/components/Layout/ContentArea.tsx` - Use tab-specific ratios
4. `docs/TAB_SPECIFIC_SPLIT_RATIOS.md` - This documentation

---

**Status:** ✅ Complete
