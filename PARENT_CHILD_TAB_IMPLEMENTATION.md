# Parent-Child Tab Hierarchy Implementation ✅

## Problem Solved

### The v1 Bug
**Before:** When a chat created multiple artifacts, old artifact tabs would remain visible in the tab bar (orphaned tabs).

```
1. Chat creates Doc A → Chat | Doc A (merged)
2. Chat creates Doc B → Chat | Doc B (merged)
   BUT Doc A tab still visible in tab bar! ❌
3. Repeat → Tab bar fills with orphaned tabs ❌
```

### The v2 Solution
**After:** Parent-child hierarchy ensures old children are REMOVED when replaced.

```
1. Chat creates Doc A → Chat | Doc A (merged)
   - Chat becomes parent, Doc A is child (hidden from tab bar) ✓
2. Chat creates Doc B → Chat | Doc B (merged)
   - Doc A is CLOSED and REMOVED ✓
   - Doc B becomes new child ✓
3. Clean tab bar with no orphans! ✓
```

---

## Key Design Changes

### 1. Tab Interface - New Fields
```typescript
export interface Tab {
  // ... existing fields ...
  
  // NEW: Parent-child hierarchy
  parentTabId: string | null;     // If child: reference to parent
  childTabIds: string[];          // If parent: [child1?, child2?] (max 2)
  displayMode: 'standalone' | 'parent' | 'child';
  position?: 'left' | 'right';    // Position within parent (for children)
}
```

### 2. Display Modes

| Mode | Description | Tab Bar Visibility |
|------|-------------|-------------------|
| `standalone` | Full-screen tab, no children | ✅ Visible |
| `parent` | Has 1-2 children, shows split view | ✅ Visible (merged title) |
| `child` | Belongs to a parent | ❌ Hidden (shown in parent's split) |

### 3. Core Rule
**Children are NEVER shown in the tab bar** - they only exist within their parent's split view.

---

## New Methods

### `addChild(parentId, childId, position)`
Add a child to a parent tab.

```typescript
addChild('chat-123', 'document-456', 'right');
// Result: Chat becomes parent, Document becomes child (hidden from tab bar)
```

### `removeChild(parentId, childId)`
Remove a child from a parent (child becomes standalone).

```typescript
removeChild('chat-123', 'document-456');
// Result: Document becomes standalone (visible in tab bar)
```

### `replaceChild(parentId, oldChildId, newChildId)`
Replace one child with another.

```typescript
replaceChild('chat-123', 'document-456', 'document-789');
// Result: Old document removed, new document becomes child
```

### `createArtifactFromChat(chatTabId, artifactTabId)` ⭐
**This is the key method that fixes the v1 bug!**

```typescript
createArtifactFromChat('chat-123', 'document-456');
```

**Logic:**
1. **No children** → Add artifact as first child
2. **1 child** → Replace child + CLOSE old child
3. **2 children** → Replace rightmost child + CLOSE old child

**Key difference:** Old children are CLOSED (removed), not made standalone.

### `promoteToStandalone(tabId)`
Convert a child to a standalone tab.

```typescript
promoteToStandalone('document-456');
// Result: Document removed from parent, becomes visible in tab bar
```

### `getVisibleTabs()`
Get only tabs that should be shown in tab bar (standalone + parent, NOT children).

```typescript
const visibleTabs = getVisibleTabs();
// Returns: Only tabs with displayMode === 'standalone' or 'parent'
```

---

## Usage Examples

### Example 1: Chat Creates Artifact
```typescript
// 1. Create chat tab
const chatId = createTab('chat', 'chat-123', 'New Chat');
// State: [Chat (standalone)]
// Tab bar shows: [Chat]

// 2. Create document from chat
const docId = createTab('document', 'doc-456', 'My Doc');
createArtifactFromChat(chatId, docId);
// State: [Chat (parent), Doc (child)]
// Tab bar shows: [Chat | My Doc] (merged)
```

### Example 2: Chat Creates Another Artifact
```typescript
// Continuing from above...
// State: [Chat (parent), Doc-456 (child)]

// 3. Create another document from chat
const newDocId = createTab('document', 'doc-789', 'Another Doc');
createArtifactFromChat(chatId, newDocId);

// What happens:
// - replaceChild(chatId, 'doc-456', 'doc-789') is called
// - closeTab('doc-456') is called → Doc-456 REMOVED ✅
// - Doc-789 becomes new child

// State: [Chat (parent), Doc-789 (child)]
// Tab bar shows: [Chat | Another Doc] (merged)
// NO orphaned Doc-456 tab! ✅
```

### Example 3: Manual Drag Merge
```typescript
// User drags Doc onto Chat to merge them
addChild('chat-123', 'document-456', 'right');
// State: Chat becomes parent, Doc becomes child (hidden from tab bar)
// Tab bar shows: [Chat | My Doc]
```

### Example 4: Unmerge Tabs
```typescript
// User double-clicks merged tab or closes child
promoteToStandalone('document-456');
// State: Doc becomes standalone (visible in tab bar again)
// Tab bar shows: [Chat] [My Doc]
```

### Example 5: Close Parent Tab
```typescript
closeTab('chat-123');
// What happens:
// - All children are closed first
// - Then parent is closed
// Result: Clean removal, no orphans!
```

---

## Component Updates

### TabBar Component
Updated to only render visible tabs:

```tsx
{getVisibleTabs().map((tab, index) => {
  const isParent = tab.displayMode === 'parent';
  const children = isParent ? tab.childTabIds.map(id => getTab(id)) : [];
  
  return (
    <Tab 
      tab={tab}
      isMerged={isParent}
      children={children}
    />
  );
})}
```

### Tab Component
Updated to show merged titles when parent has children:

```tsx
{isMerged && children.length > 0 ? (
  <span className="tab__title--merged">
    <span>{tab.title}</span>
    <span>|</span>
    <span>{children[0].title}</span>
  </span>
) : (
  <span>{tab.title}</span>
)}
```

---

## Backward Compatibility

Legacy fields maintained for smooth migration:

```typescript
interface TabState {
  // NEW primary state
  activeTabId: string | null;
  
  // Legacy state (computed from hierarchy)
  activeLeftTab: string | null;
  activeRightTab: string | null;
  isSplitView: boolean;
  
  // Legacy methods (converted to parent-child operations)
  enableSplitView(leftTabId, rightTabId); // → addChild()
  disableSplitView(); // → promoteToStandalone()
}
```

---

## Testing Checklist

### Core Scenarios
- ✅ Create standalone tab → Shows in tab bar
- ✅ Add child to parent → Parent shows merged title, child hidden
- ✅ Replace child → Old child removed, new child shown in merge
- ✅ Close parent → All children closed with it
- ✅ Promote child to standalone → Child appears in tab bar
- ✅ `getVisibleTabs()` → Only returns standalone and parent tabs

### Chat → Artifact Scenarios
- ✅ Chat creates first artifact → Merges correctly
- ✅ Chat creates second artifact → First artifact REMOVED (not orphaned)
- ✅ Chat creates third artifact → Second artifact REMOVED (not orphaned)
- ✅ Multiple chats create artifacts → Each manages its own children independently

### Drag & Drop
- ✅ Drag tab onto another → Creates parent-child relationship
- ✅ Drag tab to reorder → Works as before
- ✅ Drag child out → Promotes to standalone

### Edge Cases
- ✅ Close child while parent is active → Parent continues
- ✅ Close parent with children → All cleaned up
- ✅ Switch to child tab → Actually switches to parent
- ✅ Maximum 2 children per parent enforced

---

## Code Quality

✅ **TypeScript:** All checks pass  
✅ **Linter:** 0 errors, minimal warnings  
✅ **Backward Compat:** Legacy methods still work  
✅ **Type Safety:** New `DisplayMode` type ensures correctness

---

## Migration Notes

### For Existing Code
- All existing tab operations continue to work
- `enableSplitView()` now creates parent-child relationship
- `disableSplitView()` now promotes children to standalone
- `activeLeftTab` and `activeRightTab` are computed from hierarchy

### For New Code
- Use `createArtifactFromChat()` when chat creates artifacts
- Use `getVisibleTabs()` instead of `tabs` in tab bar rendering
- Check `displayMode` instead of `isSplitView` for new features

---

## What's Fixed

### Before (v1)
```
Tab bar: [Chat] [Doc A] [Doc B] [Doc C] [Doc D] ❌
Problem: Accumulates orphaned artifact tabs
```

### After (v2)
```
Tab bar: [Chat | Doc D] ✅
Result: Only active tabs shown, old artifacts properly cleaned up
```

**Key insight:** Children are ephemeral - they live and die with their relationship to their parent. When replaced, they are REMOVED, not orphaned.

---

## Benefits

✅ **No orphaned tabs** - Old children are closed when replaced  
✅ **Clean tab bar** - Only shows standalone and parent tabs  
✅ **Clear ownership** - Parent tracks and manages its children  
✅ **Proper cleanup** - Closing parent handles all children  
✅ **Intuitive UX** - Tab bar shows actual active state  
✅ **Backward compatible** - Existing code continues to work  
✅ **Type safe** - New types prevent misuse

---

## Future Enhancements

### Potential Extensions
- **3-column view:** Increase max children to 3
- **Nested hierarchy:** Allow children to have children (if needed)
- **Tab groups:** Allow grouping standalone tabs
- **Persistent children:** Option to preserve children when closing parent

### Current Limitations
- Maximum 2 children per parent
- No nested parent-child relationships
- Children are always closed when parent closes (no auto-promotion)

---

## Documentation

Full design doc: `docs/TAB_HIERARCHY_DESIGN.md`

Key files:
- `ui/stores/tabStore.ts` - Store implementation
- `ui/hooks/useTabs.ts` - Hook exports
- `ui/components/Tabs/TabBar.tsx` - Tab bar rendering
- `ui/components/Tabs/Tab.tsx` - Individual tab component
