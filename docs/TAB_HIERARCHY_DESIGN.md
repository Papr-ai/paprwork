# Tab Parent-Child Hierarchy Design

## The Problem (v1 Issues)

### Current v1 Behavior
1. Chat creates doc A → Merges chat + doc A in split view
2. Chat creates doc B → Replaces doc A with doc B
3. **BUG**: Doc A tab remains visible in tab bar (orphaned)
4. Repeat → Accumulates orphaned tabs

### Root Cause
- No parent-child relationship tracking
- `cleanupStandaloneTab()` makes old tabs standalone instead of removing them
- No concept of "ownership" - which tab created which artifact

---

## New Design: True Parent-Child Hierarchy

### Tab Interface
```typescript
export interface Tab {
  id: string;                    // "{type}-{id}"
  type: TabType;
  entityId: string;
  title: string;
  icon?: string;
  
  // NEW: Parent-child hierarchy
  parentTabId: string | null;    // If child: reference to parent, else null
  childTabIds: string[];         // If parent: [leftChildId?, rightChildId?] (max 2)
  displayMode: 'standalone' | 'parent' | 'child';
  
  // Position (only relevant for children)
  position?: 'left' | 'right';   // Which pane within parent (for children only)
  
  metadata?: Record<string, unknown>;
}
```

### Display Modes

| Mode | Description | parentTabId | childTabIds | Visibility |
|------|-------------|-------------|-------------|------------|
| **standalone** | Full-screen tab, no children | `null` | `[]` | Always visible in tab bar |
| **parent** | Tab with 1-2 children, shows split view | `null` | `[id1]` or `[id1, id2]` | Visible in tab bar (merged display) |
| **child** | Belongs to a parent | `parentId` | `[]` | Hidden in tab bar (shown in parent's split) |

---

## Core Rules

### 1. Tab Bar Display
- **Standalone tabs**: Show normally
- **Parent tabs**: Show as merged "Parent | Child1" or "Parent | Child1 | Child2"
- **Child tabs**: NEVER shown in tab bar (only visible within parent's split view)

### 2. Parent Constraints
- A parent can have **0-2 children**
- Children are ordered: `[leftChild, rightChild]`
- If parent has 0 children, it becomes standalone
- If parent has 1 child, show split view (parent left, child right)
- If parent has 2 children, show split view (child1 left, child2 right)

### 3. Child Constraints
- A child MUST have a parent
- A child CANNOT have children (no nested hierarchy)
- A child is REMOVED when its parent is closed
- A child can be "promoted" to standalone if parent is removed

### 4. Chat → Artifact Auto-Merge
This is the key use case that was broken:

```typescript
function createArtifactFromChat(chatTabId: string, artifactTabId: string) {
  const chatTab = getTab(chatTabId);
  
  if (!chatTab) return;
  
  // Case 1: Chat has no children → Add artifact as first child
  if (chatTab.childTabIds.length === 0) {
    addChild(chatTabId, artifactTabId, 'right');
  }
  
  // Case 2: Chat has 1 child → Replace the child
  else if (chatTab.childTabIds.length === 1) {
    const oldChildId = chatTab.childTabIds[0];
    replaceChild(chatTabId, oldChildId, artifactTabId);
    closeTab(oldChildId); // IMPORTANT: Remove old child completely
  }
  
  // Case 3: Chat has 2 children → Replace the rightmost child
  else if (chatTab.childTabIds.length === 2) {
    const oldRightChildId = chatTab.childTabIds[1];
    replaceChild(chatTabId, oldRightChildId, artifactTabId);
    closeTab(oldRightChildId); // IMPORTANT: Remove old child completely
  }
}
```

**Key difference from v1**: Old child tabs are CLOSED and REMOVED, not made standalone.

---

## Implementation Details

### Tab Store State
```typescript
interface TabState {
  tabs: Tab[];
  activeTabId: string | null;     // Active parent or standalone tab
  
  // Actions
  createTab: (type, entityId, title, parentId?) => string;
  addChild: (parentId, childId, position) => void;
  removeChild: (parentId, childId) => void;
  replaceChild: (parentId, oldChildId, newChildId) => void;
  promoteToStandalone: (tabId) => void;
  closeTab: (tabId) => void;
  // ... other actions
}
```

### Key Methods

#### `addChild(parentId, childId, position)`
```typescript
addChild(parentId, childId, position) {
  const parent = getTab(parentId);
  const child = getTab(childId);
  
  if (!parent || !child) return;
  if (parent.childTabIds.length >= 2) {
    console.error('Parent already has 2 children');
    return;
  }
  
  // Update parent
  parent.displayMode = 'parent';
  parent.childTabIds.push(childId);
  
  // Update child
  child.parentTabId = parentId;
  child.displayMode = 'child';
  child.position = position;
}
```

#### `replaceChild(parentId, oldChildId, newChildId)`
```typescript
replaceChild(parentId, oldChildId, newChildId) {
  const parent = getTab(parentId);
  const oldChild = getTab(oldChildId);
  const newChild = getTab(newChildId);
  
  if (!parent || !oldChild || !newChild) return;
  
  // Find old child position
  const position = oldChild.position;
  const index = parent.childTabIds.indexOf(oldChildId);
  
  if (index === -1) return;
  
  // Remove old child from parent
  parent.childTabIds.splice(index, 1, newChildId);
  
  // Update old child (will be closed next)
  oldChild.parentTabId = null;
  oldChild.displayMode = 'standalone';
  
  // Update new child
  newChild.parentTabId = parentId;
  newChild.displayMode = 'child';
  newChild.position = position;
}
```

#### `closeTab(tabId)`
```typescript
closeTab(tabId) {
  const tab = getTab(tabId);
  if (!tab) return;
  
  // If closing a parent: handle children
  if (tab.displayMode === 'parent' && tab.childTabIds.length > 0) {
    tab.childTabIds.forEach(childId => {
      // Option A: Close children (clean)
      closeTab(childId);
      
      // Option B: Promote children to standalone (preserve work)
      // promoteToStandalone(childId);
    });
  }
  
  // If closing a child: remove from parent
  if (tab.parentTabId) {
    removeChild(tab.parentTabId, tabId);
  }
  
  // Remove tab
  tabs = tabs.filter(t => t.id !== tabId);
  
  // Update active tab if needed
  if (activeTabId === tabId) {
    activeTabId = tabs[0]?.id || null;
  }
}
```

#### `promoteToStandalone(tabId)`
```typescript
promoteToStandalone(tabId) {
  const tab = getTab(tabId);
  if (!tab) return;
  
  // Remove from parent
  if (tab.parentTabId) {
    const parent = getTab(tab.parentTabId);
    if (parent) {
      parent.childTabIds = parent.childTabIds.filter(id => id !== tabId);
      
      // If parent has no more children, make it standalone
      if (parent.childTabIds.length === 0) {
        parent.displayMode = 'standalone';
      }
    }
  }
  
  // Make standalone
  tab.parentTabId = null;
  tab.displayMode = 'standalone';
  tab.position = undefined;
}
```

---

## UI Rendering

### Tab Bar
```typescript
function renderTabBar() {
  // Only show standalone and parent tabs (NOT children)
  const visibleTabs = tabs.filter(t => 
    t.displayMode === 'standalone' || t.displayMode === 'parent'
  );
  
  return visibleTabs.map(tab => {
    if (tab.displayMode === 'parent') {
      // Show merged tab with children titles
      const children = tab.childTabIds.map(id => getTab(id));
      return (
        <MergedTab 
          parentTab={tab}
          children={children}
        />
      );
    } else {
      return <Tab tab={tab} />;
    }
  });
}
```

### Content Area
```typescript
function renderContentArea() {
  const activeTab = getTab(activeTabId);
  if (!activeTab) return null;
  
  // Standalone: Full screen
  if (activeTab.displayMode === 'standalone') {
    return <SingleView tab={activeTab} />;
  }
  
  // Parent with children: Split view
  if (activeTab.displayMode === 'parent') {
    const leftChild = getTab(activeTab.childTabIds[0]);
    const rightChild = getTab(activeTab.childTabIds[1]);
    
    if (activeTab.childTabIds.length === 1) {
      // Parent + 1 child
      return (
        <SplitView 
          left={<View tab={activeTab} />}
          right={leftChild ? <View tab={leftChild} /> : null}
        />
      );
    } else {
      // 2 children
      return (
        <SplitView 
          left={leftChild ? <View tab={leftChild} /> : null}
          right={rightChild ? <View tab={rightChild} /> : null}
        />
      );
    }
  }
  
  return null;
}
```

---

## Common Scenarios

### 1. User Opens New Chat
```typescript
createTab('chat', chatId, 'New Chat')
// Result: Standalone chat tab, takes full screen
```

### 2. Chat Creates Document
```typescript
// Chat already exists as standalone
createTab('document', docId, 'New Doc')
addChild(chatTabId, docTabId, 'right')
// Result: Chat becomes parent, doc is child, split view shows chat | doc
```

### 3. Chat Creates Another Document
```typescript
// Chat is parent with 1 child (previous doc)
createTab('document', newDocId, 'Another Doc')
replaceChild(chatTabId, oldDocId, newDocId)
closeTab(oldDocId)
// Result: Old doc removed, new doc replaces it, split view shows chat | new doc
```

### 4. User Closes Chat (Parent)
```typescript
closeTab(chatTabId)
// Option A: Close all children (clean slate)
// Option B: Promote children to standalone (preserve work)
// Result: Chat and children removed OR children become standalone
```

### 5. User Manually Merges Two Standalone Tabs
```typescript
// Drag tab A onto tab B
addChild(tabBId, tabAId, 'right')
// Result: Tab B becomes parent, tab A becomes child (hidden from tab bar)
```

### 6. User Unmerges Parent
```typescript
// Double-click merged tab or close child
promoteToStandalone(childTabId)
// Result: Child becomes standalone (visible in tab bar), parent loses child
```

---

## Migration from Current System

To migrate the current flat system to hierarchical:

1. Add new fields to Tab interface
2. Initialize all existing tabs as standalone
3. When enabling split view → Convert to parent-child
4. Update all tab operations to respect hierarchy
5. Filter tab bar to only show visible tabs

---

## Benefits

✅ **No orphaned tabs** - Children are closed when replaced  
✅ **Clear ownership** - Parent tracks its children  
✅ **Proper cleanup** - Closing parent handles children  
✅ **Intuitive UX** - Tab bar only shows active/standalone tabs  
✅ **Flexible** - Can promote children to standalone if needed  
✅ **Scalable** - Easy to add 3-column view (increase max children)

---

## Next Steps

1. Update `Tab` interface in `tabStore.ts`
2. Implement parent-child methods (`addChild`, `removeChild`, etc.)
3. Update `createTab` to support `parentTabId` parameter
4. Add `createArtifactFromChat` helper
5. Update TabBar to filter child tabs
6. Update ContentArea to render based on hierarchy
7. Add tests for all scenarios
