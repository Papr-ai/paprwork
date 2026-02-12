# Parallel Chat Architecture - Complete Refactor

## Problem

**Before:** `ChatContainer`, `useAgent.sendMessage`, and `isSending` all used `activeChat` or `activeTabId`, which prevented parallel streaming:
- Only one chat could send messages at a time (global `isSending`)
- Input would be blocked in all tabs if any tab was streaming
- Switching tabs during streaming would cause issues

**After:** Each `ChatContainer` is scoped to a specific `chatId` and operates independently.

---

## Architecture Changes

### 1. ChatContainer - Now Accepts `chatId` Prop

**Before:**
```typescript
export const ChatContainer: React.FC = () => {
  const { messages, isSending, isLoading, error } = useChat();
  // Derived from activeChat internally
}
```

**After:**
```typescript
interface ChatContainerProps {
  chatId: string;
}

export const ChatContainer: React.FC<ChatContainerProps> = ({ chatId }) => {
  // Get messages for THIS specific chat
  const messages = useChatStore((state) => {
    const chatState = state.chatStates.get(chatId);
    return chatState?.messages || [];
  });

  const isSending = useChatStore((state) => {
    const chatState = state.chatStates.get(chatId);
    return chatState?.isSending || false;
  });

  // Send message for THIS chat
  await sendMessage(message, config, chatId);
}
```

### 2. ContentArea - Passes `chatId` to ChatContainer

**Before:**
```typescript
case "chat":
  return <ChatContainer />;
```

**After:**
```typescript
case "chat":
  return <ChatContainer chatId={tab.entityId} />;
```

### 3. useAgent.sendMessage - Takes `chatId` Parameter

**Before:**
```typescript
sendMessage: (message: string, config: AgentConfig) => {
  const { activeTabId } = useTabStore.getState();
  const tab = getTab(activeTabId);
  const chatId = tab.entityId;  // Derived from active tab
  // ...
}
```

**After:**
```typescript
sendMessage: (message: string, config: AgentConfig, chatId: string) => {
  // chatId is passed explicitly - no dependency on active tab
  const isFirstMessage = chatId.startsWith("temp-");
  let finalChatId = chatId;
  
  // Route everything by chatId, not activeTab
  setSending(finalChatId, true);  // Per-chat
  setTabStreaming(`chat-${finalChatId}`, true);  // This chat's tab
  // ...
}
```

### 4. chatStore.setSending - Now Per-Chat

**Before:**
```typescript
setSending: (sending) => set({ isSending: sending }),  // Global
```

**After:**
```typescript
setSending: (chatId, sending) =>
  set((state) => {
    const chatState = state.chatStates.get(chatId);
    const newChatStates = new Map(state.chatStates);
    newChatStates.set(chatId, {
      ...chatState,
      isSending: sending,  // Per-chat
    });
    return { chatStates: newChatStates };
  }),
```

---

## Benefits

### ✅ True Parallel Streaming
- Chat A can be streaming while you send a message in Chat B
- Each chat has its own `isSending` state
- Input is only blocked for the chat that's sending

### ✅ No Active Tab Dependency
- All routing is by `chatId` from the chunk
- `activeTab` is only used for display (which tab to show)
- Switching tabs during streaming doesn't break anything

### ✅ Multiple ChatContainer Instances
- Each `ChatContainer` instance is scoped to a specific `chatId`
- Messages, sending state, and input are all per-chat
- Mirrors V1's per-chat DOM container architecture

---

## Data Flow

### Sending a Message

```
User types in Chat A's input
  → ChatContainer(chatId="abc123")
  → sendMessage(message, config, "abc123")
  → setSending("abc123", true)  ✅ Only Chat A is disabled
  → setTabStreaming("chat-abc123", true)  ✅ Blue dot on Chat A's tab
  → Gateway streams back with chatId="abc123" in every chunk
  → handleStreamChunk routes by chunk.chatId
  → updateStreamingMessage(messageId, content, "abc123")
  → Chat A's messages update
```

### Parallel Scenario

```
Chat A streaming...
  → User switches to Chat B tab
  → ContentArea renders <ChatContainer chatId="def456" />
  → Chat B's messages load from chatStates.get("def456")
  → Chat B's isSending = false (different chat state)
  → User can type and send in Chat B
  → Both Chat A and Chat B stream independently
  → Each chunk has chatId, routes to correct chat
```

---

## Comparison to V1

| Aspect | V1 | V2 (Refactored) |
|--------|----|----|
| **Container scope** | `#chat-messages-${chatId}` DOM | `<ChatContainer chatId={chatId} />` |
| **Messages** | Per-chat DOM elements | `chatStates.get(chatId).messages` |
| **Input blocking** | Per-chat (separate inputs) | Per-chat (`chatStates.get(chatId).isSending`) |
| **Streaming routing** | `chatStreamingState.get(chatId)` | `chatStates.get(chatId)` |
| **Tab switching** | CSS `display` toggle | React re-renders with new `chatId` |

---

## Files Changed

1. **ContentArea.tsx** - Pass `chatId` to `ChatContainer`
2. **ChatContainer.tsx** - Accept `chatId` prop, use it instead of `activeChat`
3. **useAgent.ts** - `sendMessage` takes `chatId` parameter, uses it for all operations
4. **chatStore.ts** - `setSending` now per-chat, removed global `isSending`
5. **useChat.ts** - Derive `isSending` from active chat's state

---

## Testing Parallel Streaming

1. Open Chat A, send message → starts streaming
2. Create new Chat B tab
3. Send message in Chat B while Chat A is still streaming
4. ✅ Chat B input should NOT be blocked
5. ✅ Both chats stream independently
6. ✅ Blue dots on both tabs
7. Switch between tabs → messages appear in correct chats

---

## Result

V2 now matches V1's parallel streaming architecture:
- Each chat operates independently
- No shared global state for sending/streaming
- Multiple chats can stream simultaneously
- Switching tabs doesn't interrupt streaming
