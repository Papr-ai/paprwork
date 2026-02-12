# Simplified Tab Merging UX

## Core Principle: "Creator Stays, Other Replaces"

### Rule 1: Max 2 Panes
- One parent + one child = 2 panes total
- NO parent + 2 children (that would be 3 panes)

### Rule 2: No Auto-Swap
- Chat, meeting, artifact can be on ANY side (left or right)
- No magic position changes

### Rule 3: Creator Stays Logic
When a tab creates/opens an artifact:
- **The creator stays in place**
- **The OTHER pane gets replaced**

## Examples

### Chat Creates Artifact

```
Scenario 1: Chat standalone
Before: [Chat]
Chat creates artifact
After: [Chat (parent)] | [Artifact (child right)]
```

```
Scenario 2: Chat is parent with existing child
Before: [Chat (parent)] | [Doc (child right)]
Chat creates artifact
After: [Chat (parent)] | [Artifact (child right)]  (Doc replaced)
```

```
Scenario 3: Chat is child
Before: [Doc (parent)] | [Chat (child right)]
Chat creates artifact
After: [Artifact (parent)] | [Chat (child right)]  (Doc removed, artifact becomes parent, chat stays in same position!)
```

### Meeting Creates Artifact

Same logic as chat - meeting stays, other pane replaced.

```
Before: [Meeting (parent)] | [Chat (child right)]
Meeting creates artifact
After: [Meeting (parent)] | [Artifact (child right)]  (Chat replaced)
```

### Artifact Tab Opens Another Artifact

Same logic - current artifact stays, other pane replaced.

```
Before: [Chat (parent)] | [Artifact1 (child right)]
User opens Artifact2 from artifact tab
After: [Chat (parent)] | [Artifact2 (child right)]  (Artifact1 replaced)
```

## Implementation

### 1. Simplified `addChild`
- Removed auto-swap logic (no more chat-must-be-parent rule)
- Enforces max 1 child: if parent has any child, replace it

### 2. Updated `createArtifactFromChat`
```typescript
createArtifactFromChat: (chatTabId, artifactTabId) => {
  const chat = get().getTab(chatTabId);
  if (!chat) return;

  // Case 1: Chat is standalone → make it parent
  if (chat.displayMode === "standalone") {
    get().addChild(chatTabId, artifactTabId, "right");
    return;
  }

  // Case 2: Chat is parent → replace child
  if (chat.displayMode === "parent") {
    get().addChild(chatTabId, artifactTabId, "right");
    return;
  }

  // Case 3: Chat is child → replace parent, keep chat in SAME position
  if (chat.displayMode === "child" && chat.parentTabId) {
    const oldParentId = chat.parentTabId;
    const chatPosition = chat.position!; // Preserve position!
    
    get().promoteToStandalone(chatTabId);
    set((state) => ({
      tabs: state.tabs.filter((t) => t.id !== oldParentId),
    }));
    
    // Artifact becomes parent, chat stays as child in same position
    get().addChild(artifactTabId, chatTabId, chatPosition);
  }
}
```

## Benefits

✅ **Simpler**: 3 clear rules vs. 5 prescriptive rules
✅ **Predictable**: Creator always stays, other always replaces
✅ **Flexible**: Any tab type can be on any side
✅ **Intuitive**: Matches user's mental model of "what I'm working with stays"

## Test Coverage

- Max 1 child enforcement
- Creator stays when creating artifacts
- Position preservation when promoting from child
- Existing child replacement
