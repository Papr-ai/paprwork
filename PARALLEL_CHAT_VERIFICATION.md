# Parallel Chat Architecture - V2 Verification

## Summary

Paprwork V2 **already supports parallel chat streaming correctly**. The architecture mirrors V1's proven design.

---

## How It Works

### 1. Per-Chat State (like V1's `chatStreamingState` Map)

**V2: `chatStore.chatStates` Map**
```typescript
chatStates: Map<string, ChatState>  // Key = chatId
```

Each chat has its own state:
```typescript
interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  isSending: boolean;
  isStreaming: boolean;
  hasUnread: boolean;
}
```

### 2. ChatId in Every Event (like V1)

**Gateway sends `chatId` with every chunk:**
```typescript
// AgentService.streamAgent() yields:
yield {
  type: 'text-delta',
  payload: { text: chunk },
  chatId,  // ✅ Always included
}
```

**UI receives and routes by chatId:**
```typescript
// useAgent.ts handleStreamChunk()
const chatId = (chunk as any).chatId;
if (!chatId) {
  console.error("[useAgent] Chunk missing chatId:", chunk);
  return;
}

// Route to correct chat state
updateStreamingMessage(messageId, content, chatId);
```

### 3. Messages Stored Per-Chat (not global array)

**V1:**
```javascript
// Each chat has persistent DOM container
const container = document.getElementById(`chat-messages-${chatId}`);
appendToTextStream(textDelta); // Appends to this chat's container
```

**V2:**
```typescript
// Each chat has state entry in Map
addMessage: (message, chatId) => {
  const chatState = state.chatStates.get(chatId) || defaultChatState;
  const updatedMessages = [...chatState.messages, message];
  newChatStates.set(chatId, { ...chatState, messages: updatedMessages });
}
```

### 4. React Rendering Scoped to Active Chat

**V2:**
```typescript
// useChat derives messages from active chat only
const messages = useChatStore((state) => {
  if (!activeChat) return [];
  const chatState = state.chatStates.get(activeChat);
  return chatState?.messages || [];  // ✅ Only active chat's messages
});

// MessageList renders these messages
<MessageList messages={messages} />
```

When user switches tabs:
- `activeChat` changes (from tabStore)
- `useChat` selector re-runs
- New chat's messages are retrieved from `chatStates.get(newChatId)`
- MessageList re-renders with new chat's messages

**Hidden chats continue streaming:**
- Streaming chunks still arrive with `chatId`
- `updateStreamingMessage(messageId, content, chatId)` updates the correct chat's state
- When user switches back, messages are already there

---

## Key Differences from V1

| Aspect | V1 | V2 |
|--------|----|----|
| Storage | Per-chat DOM containers | Per-chat state Map |
| Routing | `chatStreamingState.get(chatId).container` | `chatStates.get(chatId).messages` |
| Rendering | Direct DOM append to container | React render from state |
| Tab switch | Change `display` CSS | Change `activeChat`, React re-renders |
| Hidden chat updates | Append to hidden DOM | Update state Map, render when active |

---

## Verification

### ✅ Multiple chats can stream in parallel
- Each stream yields `chatId` with every chunk
- `chatStates` Map keeps messages separate
- No shared global state

### ✅ Switching tabs during streaming works
- Active tab changes via `tabStore`
- `useChat` derives messages from new `activeChat`
- Old chat continues streaming in background (state updates)

### ✅ Messages route to correct chat
- `handleStreamChunk` extracts `chatId` from chunk
- `updateStreamingMessage(messageId, content, chatId)` targets correct state
- No dependency on `activeChat` for routing

---

## Conclusion

**V2 architecture is correct.** The user's concern is valid (don't use activeChat for routing), but we're already routing by chatId from the chunk. The only place activeChat is used is for **display** (which chat to show), not for **routing** (where to store messages).

No changes needed to the core architecture.
