# Message Queue ChatId Scoping Fix

## Problem

Queued messages were not scoped to specific chatIds. This created a critical bug where:

1. User types a message in Chat A (while agent is responding)
2. Message gets queued
3. User switches to Chat B
4. When the queue processes, the message from Chat A is sent to Chat B

This happened because the `messageQueue` state in `ChatContainer.tsx` was component-level but not filtered by chatId.

## Solution

Added `chatId` to the `QueuedMessage` interface and filtered the queue at all access points:

### 1. Updated QueuedMessage Interface

```typescript
export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: number;
  chatId: string; // ✅ Added chatId
}
```

### 2. Store chatId When Queueing

```typescript
const handleQueueMessage = useCallback((message: string, context?: Artifact[]) => {
  const queuedMessage: QueuedMessage = {
    id: `queued-${Date.now()}-${Math.random()}`,
    text: message,
    timestamp: Date.now(),
    chatId, // ✅ Scope message to this chat
  };
  setMessageQueue(prev => [...prev, queuedMessage]);
}, [chatId]);
```

### 3. Filter Queue for Current Chat

Added a `useMemo` to create a filtered queue containing only messages for the current chat:

```typescript
const currentChatQueue = useMemo(
  () => messageQueue.filter(q => q.chatId === chatId),
  [messageQueue, chatId]
);
```

### 4. Updated All Queue Operations

**Display Only Current Chat's Messages:**
```typescript
<QueuedMessages
  queue={currentChatQueue}
  onSendNow={handleSendQueuedNow}
  onRemove={handleRemoveQueued}
/>
```

**Show Correct Count:**
```typescript
<InputBar
  queuedCount={currentChatQueue.length}
  placeholder={
    currentChatQueue.length > 0
      ? "Send follow-up..." 
      : "Type a message..."
  }
  ...
/>
```

**Process Only Current Chat's Queue:**
```typescript
const processNextQueued = useCallback(async () => {
  if (isProcessingQueue.current || currentChatQueue.length === 0 || isSending) {
    return;
  }

  isProcessingQueue.current = true;
  const nextMessage = currentChatQueue[0];
  
  setMessageQueue(prev => prev.filter(q => q.id !== nextMessage.id));

  try {
    await handleSendMessage(nextMessage.text);
  } catch (error) {
    console.error('[ChatContainer] Failed to send queued message:', error);
  } finally {
    isProcessingQueue.current = false;
  }
}, [currentChatQueue, isSending, handleSendMessage]);
```

**Verify chatId When Sending Now:**
```typescript
const handleSendQueuedNow = useCallback(async (messageId: string) => {
  const queued = messageQueue.find(q => q.id === messageId && q.chatId === chatId);
  if (!queued) return;
  
  // ... rest of logic
}, [messageQueue, handleStopAgent, handleSendMessage, chatId]);
```

## Result

Now each chat has its own logical queue, even though they're stored in a single array:

- Messages queued in Chat A stay in Chat A
- Messages queued in Chat B stay in Chat B
- Switching chats only shows/processes messages for the active chat
- No cross-chat message contamination

## Files Modified

- `ui/components/Chat/QueuedMessages.tsx` - Added `chatId` to interface
- `ui/components/Chat/ChatContainer.tsx` - Added chatId scoping to all queue operations

## Testing Scenarios

1. ✅ Queue message in Chat A, switch to Chat B → Queue should be empty in Chat B
2. ✅ Queue messages in both chats → Each chat shows only its own queued messages
3. ✅ Queue message in Chat A, stay in Chat A → Message processes correctly in Chat A
4. ✅ Queue multiple messages in Chat A, switch to Chat B, come back → Messages still queued in Chat A
