# Usage Example: Chat Creating Artifacts

## How to Use the New Parent-Child Tab System

### When Chat Creates a Document

In your chat message handler, when the AI creates a document artifact:

```typescript
// In ChatContainer.tsx or wherever you handle artifact creation

function handleArtifactCreated(artifactData: {
  type: 'document' | 'app';
  id: string;
  title: string;
  chatId: string; // The chat that created this artifact
}) {
  const { createTab, createArtifactFromChat } = useTabs();
  
  // 1. Create the artifact tab
  const artifactTabId = createTab(
    artifactData.type,
    artifactData.id,
    artifactData.title
  );
  
  // 2. Auto-merge with chat (replaces any existing artifact)
  const chatTabId = `chat-${artifactData.chatId}`;
  createArtifactFromChat(chatTabId, artifactTabId);
  
  // That's it! The old artifact (if any) is automatically cleaned up
}
```

### What Happens Internally

```typescript
// First artifact
createArtifactFromChat('chat-123', 'document-456');
// Result: Chat becomes parent, Doc-456 is child
// Tab bar: [Chat | Doc-456]

// Second artifact (replaces first)
createArtifactFromChat('chat-123', 'document-789');
// Result: Doc-456 is CLOSED and REMOVED
//         Doc-789 becomes new child
// Tab bar: [Chat | Doc-789]  ← Clean, no orphaned Doc-456!
```

### Example: Complete Integration

```typescript
// ui/components/Chat/ChatContainer.tsx

import { useTabs } from "../../hooks/useTabs";
import { useEffect } from "react";

export function ChatContainer() {
  const { createTab, createArtifactFromChat, activeTabId, getTab } = useTabs();
  const { messages, sendMessage } = useChat();
  
  // Get current chat ID from active tab
  const currentTab = getTab(activeTabId || '');
  const currentChatId = currentTab?.type === 'chat' ? currentTab.entityId : null;
  
  // Listen for artifact creation events
  useEffect(() => {
    const handleArtifactEvent = (event: CustomEvent) => {
      const { type, id, title, chatId } = event.detail;
      
      // Only handle artifacts from current chat
      if (chatId !== currentChatId) return;
      
      // Create artifact tab
      const artifactTabId = createTab(type, id, title);
      
      // Auto-merge with chat (handles replacement automatically)
      const chatTabId = `chat-${chatId}`;
      createArtifactFromChat(chatTabId, artifactTabId);
      
      console.log(`Artifact ${type}:${id} merged with chat ${chatId}`);
    };
    
    window.addEventListener('artifact-created', handleArtifactEvent as EventListener);
    
    return () => {
      window.removeEventListener('artifact-created', handleArtifactEvent as EventListener);
    };
  }, [currentChatId, createTab, createArtifactFromChat]);
  
  return (
    <div className="chat-container">
      {/* Your chat UI */}
    </div>
  );
}
```

### Example: Gateway WebSocket Handler

```typescript
// In your gateway WebSocket handler for documents/apps

export async function handleDocumentCreated(
  ws: WebSocket,
  message: {
    documentId: string;
    title: string;
    chatId?: string; // Include chat ID if created from chat
  }
) {
  const document = await documentService.createDocument(message.title);
  
  // Send back to UI with chat context
  ws.send(JSON.stringify({
    type: 'document:created',
    data: {
      document,
      chatId: message.chatId, // Pass through chat ID
    },
  }));
}
```

### Example: UI Event Handler

```typescript
// In your gateway client handler

gatewayClient.on('document:created', (data) => {
  const { document, chatId } = data;
  
  // Dispatch event for UI to handle
  window.dispatchEvent(new CustomEvent('artifact-created', {
    detail: {
      type: 'document',
      id: document.id,
      title: document.title,
      chatId: chatId,
    },
  }));
});
```

---

## Manual Tab Operations

### Create Standalone Tab (No Parent)

```typescript
const { createTab } = useTabs();

// Just create the tab normally
const tabId = createTab('chat', 'chat-123', 'New Chat');
// Result: Standalone tab, takes full screen
```

### Manually Merge Two Tabs

```typescript
const { addChild } = useTabs();

// User drags Tab A onto Tab B to merge them
addChild('tab-b-id', 'tab-a-id', 'right');
// Result: Tab B becomes parent, Tab A becomes child (hidden from tab bar)
```

### Unmerge Tabs

```typescript
const { promoteToStandalone } = useTabs();

// User double-clicks merged tab or wants to unmerge
promoteToStandalone('child-tab-id');
// Result: Child becomes standalone, visible in tab bar
```

### Replace Child Manually

```typescript
const { replaceChild, closeTab } = useTabs();

// Replace one child with another
replaceChild('parent-id', 'old-child-id', 'new-child-id');
closeTab('old-child-id'); // Clean up old child
```

---

## Testing Scenarios

### Scenario 1: Chat Creates Multiple Documents

```typescript
// User starts chat
const chatId = createTab('chat', 'chat-123', 'Work Chat');
// Tab bar: [Work Chat]

// AI creates first document
const doc1 = createTab('document', 'doc-1', 'Design Doc');
createArtifactFromChat(chatId, doc1);
// Tab bar: [Work Chat | Design Doc]

// AI creates second document
const doc2 = createTab('document', 'doc-2', 'Implementation Plan');
createArtifactFromChat(chatId, doc2);
// Tab bar: [Work Chat | Implementation Plan]
// NOTE: Design Doc is GONE from tab bar! ✅

// AI creates third document
const doc3 = createTab('document', 'doc-3', 'Test Plan');
createArtifactFromChat(chatId, doc3);
// Tab bar: [Work Chat | Test Plan]
// NOTE: Implementation Plan is GONE! ✅
```

### Scenario 2: Multiple Chats Creating Artifacts

```typescript
// Chat A creates document
const chatA = createTab('chat', 'chat-a', 'Chat A');
const docA = createTab('document', 'doc-a', 'Doc A');
createArtifactFromChat(chatA, docA);
// Tab bar: [Chat A | Doc A]

// Chat B creates document
const chatB = createTab('chat', 'chat-b', 'Chat B');
const docB = createTab('document', 'doc-b', 'Doc B');
createArtifactFromChat(chatB, docB);
// Tab bar: [Chat A | Doc A] [Chat B | Doc B]

// Each chat manages its own children independently! ✅
```

### Scenario 3: User Closes Parent Chat

```typescript
const chatId = createTab('chat', 'chat-123', 'My Chat');
const docId = createTab('document', 'doc-456', 'My Doc');
createArtifactFromChat(chatId, docId);
// Tab bar: [My Chat | My Doc]

// User closes the chat
closeTab(chatId);
// Result: BOTH chat and doc are closed and removed! ✅
// Tab bar: (empty or shows next tab)
```

---

## Migration from Old Code

### Before (v1 style)

```typescript
// Old v1 way
function handleDocumentCreated(doc) {
  const docTabId = createTab('document', doc.id, doc.title);
  const chatTabId = getCurrentChatTab();
  
  // This would just merge, not replace
  enableSplitView(chatTabId, docTabId);
  
  // Old doc tabs would accumulate! ❌
}
```

### After (v2 with hierarchy)

```typescript
// New v2 way
function handleDocumentCreated(doc, chatId) {
  const docTabId = createTab('document', doc.id, doc.title);
  const chatTabId = `chat-${chatId}`;
  
  // This replaces and cleans up old artifacts
  createArtifactFromChat(chatTabId, docTabId);
  
  // Old doc tabs are removed! ✅
}
```

---

## Key Takeaways

1. **Use `createArtifactFromChat()`** when chat creates artifacts - it handles replacement and cleanup automatically

2. **Children are ephemeral** - when replaced, they are REMOVED, not orphaned

3. **Tab bar only shows visible tabs** - use `getVisibleTabs()` instead of `tabs` for rendering

4. **Parent tracks children** - closing parent closes all children

5. **Backward compatible** - old `enableSplitView()` still works, just converts to parent-child internally

---

## Next Steps

1. Update your chat artifact creation handler to use `createArtifactFromChat()`
2. Test with multiple artifact creations to verify no orphaned tabs
3. Verify tab bar only shows active/visible tabs
4. Test closing parent tabs cleans up children properly

Done! 🎉
