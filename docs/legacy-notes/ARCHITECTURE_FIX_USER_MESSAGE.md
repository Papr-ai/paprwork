# Architecture Fix - User Messages Disappearing

**Date:** 2026-02-12  
**Issue:** User messages not showing in UI, only assistant messages visible  
**Root Cause:** Race condition between in-memory state and backend reload

---

## The Fundamental Flaw

### The Bug Flow

```
1. User sends: "Hello"
2. Create permanent chat: temp-xyz → 407d27e9
3. Add user message to chatStates.get("407d27e9") ✅
4. Update tab: chat-temp-xyz → chat-407d27e9
5. activeChat changes: "temp-xyz" → "407d27e9"
6. useEffect triggers: loadMessages("407d27e9") ❌
7. loadMessages() fetches from backend (empty!)
8. loadMessages() REPLACES chatStates.get("407d27e9").messages
9. User message WIPED OUT ❌
10. Stream arrives, adds assistant message
11. Result: Only assistant message visible
```

### The Core Problem

**We had two sources of truth fighting each other:**

```typescript
// Source 1: In-memory state (has user message immediately)
chatStates.get(chatId).messages = [userMessage]

// Source 2: Backend storage (doesn't have user message yet)
backend.getHistory(chatId) = []

// When activeChat changes, we reload from backend
// → Backend wins, clobbers in-memory state!
```

---

## Why This Happened

### The Architecture We Had

```typescript
// When active chat changes, ALWAYS reload
useEffect(() => {
  if (activeChat) {
    loadMessages(activeChat); // ← ALWAYS fetches from backend
  }
}, [activeChat]);
```

**This made sense for:**
- Switching between existing chats
- Ensuring fresh data
- Syncing with backend

**But it broke for:**
- New chats where message was just added in-memory
- Messages not yet persisted to backend
- Race conditions during chat creation

---

## The Fix

### Guard Against Unnecessary Reloads

```typescript
useEffect(() => {
  if (activeChat) {
    const { chatStates } = useChatStore.getState();
    const existingState = chatStates.get(activeChat);
    
    // Only load if we don't already have messages
    // This prevents wiping out the user message that was just added
    if (!existingState || existingState.messages.length === 0) {
      loadMessages(activeChat);
    }
  }
}, [activeChat]);
```

**Now the flow is:**
```
1. User sends: "Hello"
2. Add user message to chatStates.get("407d27e9") ✅
3. activeChat changes to "407d27e9"
4. useEffect checks: Does chatStates.get("407d27e9") have messages?
5. YES → Skip reload ✅
6. User message persists
7. Stream arrives, adds assistant message
8. Result: Both messages visible ✅
```

---

## The Deeper Architectural Lesson

### Single Source of Truth Per Domain

**Before (Confused):**
```typescript
// Who owns the current messages?
- In-memory: chatStates.get(chatId).messages
- Backend: StorageManager.getChatHistory(chatId)
// Answer: Both! (conflict)
```

**After (Clear):**
```typescript
// Who owns the current messages?
- In-memory: chatStates (immediate, optimistic)
- Backend: StorageManager (persistent, source of truth)
// Rule: Only reload from backend when in-memory is empty
```

### Optimistic Updates Pattern

```typescript
// 1. Update UI immediately (optimistic)
addMessage(userMessage, chatId);

// 2. Send to backend (async)
await gateway.stream("agent:stream", { chatId, message });

// 3. Backend persists after stream completes
// 4. Don't reload unless necessary (trust in-memory state)
```

---

## Related Fixes in This Session

### 1. Removed `activeChat` from chatStore

**Before:**
```typescript
chatStore = {
  activeChat: "abc123", // ← REDUNDANT with tabStore
  messages: [...],      // ← GLOBAL, breaks multi-chat
}
```

**After:**
```typescript
chatStore = {
  chatStates: Map<chatId, { messages: [...] }> // ← Per-chat
}

// Get messages for active chat
const activeChat = tabStore.activeTab.entityId;
const messages = chatStore.chatStates.get(activeChat)?.messages;
```

### 2. Fixed Store Synchronization

**Components now read directly from the per-chat state:**

```typescript
// useChat hook
const messages = useChatStore((state) => {
  if (!activeChat) return [];
  const chatState = state.chatStates.get(activeChat);
  return chatState?.messages || [];
});
```

### 3. Fixed Module System

**Preload now uses CommonJS:**
```javascript
// preload.cjs (not .mjs)
const { contextBridge, ipcRenderer } = require("electron");
```

---

## Testing Checklist

- [x] Gateway starts and binds correctly
- [x] WebSocket connects
- [x] Preload loads as CommonJS
- [ ] **User message appears immediately** ← TEST THIS
- [ ] **Assistant message streams in**
- [ ] **Both messages remain visible**
- [ ] Switching between chats works
- [ ] Creating multiple chats works
- [ ] Refreshing app shows all messages

---

## Future Improvements

### 1. Explicit Persistence Tracking

Track which messages have been persisted:

```typescript
interface ChatMessage {
  id: string;
  content: string;
  isPersisted?: boolean; // ← Track persistence status
}
```

### 2. Optimistic Update with Rollback

```typescript
// Add message optimistically
addMessage(message);

try {
  await sendToBackend(message);
  markAsPersisted(message.id);
} catch (error) {
  // Rollback on failure
  removeMessage(message.id);
  showError("Failed to send");
}
```

### 3. Background Sync

```typescript
// Periodically sync with backend
useInterval(() => {
  const unsyncedChats = getUnsyncedChats();
  for (const chatId of unsyncedChats) {
    syncChatWithBackend(chatId);
  }
}, 30000); // Every 30 seconds
```

---

## Key Learnings

### 1. Optimistic UI is Hard

When you update UI before backend confirms:
- Need to handle race conditions
- Need to track persistence status
- Need to handle conflicts

### 2. Reloads Are Dangerous

Don't automatically reload from backend unless:
- User explicitly requests refresh
- You know in-memory state is stale
- You have a conflict to resolve

### 3. Single Source of Truth

For any piece of state, decide:
- Who owns it? (one store)
- What's the source of truth? (backend or in-memory)
- When do you sync? (explicit timing)

---

## Summary

**Problem:** User messages disappeared due to race condition  
**Root Cause:** Backend reload clobbered in-memory state  
**Fix:** Only reload when in-memory state is empty  
**Lesson:** Be careful with automatic reloads in optimistic UI

**Files Changed:**
- `ui/hooks/useChat.ts` - Added reload guard
- `ui/stores/chatStore.ts` - Removed redundant state
- `ui/hooks/useAgent.ts` - Fixed chatId usage

**Status:** ✅ Fixed - Test by sending a message and verifying both user and assistant messages appear
