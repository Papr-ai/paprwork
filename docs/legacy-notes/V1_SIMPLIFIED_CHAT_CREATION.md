# V1-Style Simplified Chat Creation

## Problem
The V2 implementation was over-engineered, creating permanent chat IDs **during streaming** and requiring complex state migration logic:

- `chat-created` chunk handler in `useAgent`
- `migrateChatId()` in `chatStore`
- `updateTabId()` in `tabStore`
- Tracking `realChatId` vs `sessionId` throughout the stream
- `finalChatId` tracking in WebSocket handler

This led to bugs where:
- Messages stayed in temp chat state
- Title generation used wrong chat ID
- Tab updates didn't work correctly

## V1's Simpler Approach
Paprwork V1 creates permanent chat IDs **before streaming**:

1. Check if temp chat (starts with `temp-`)
2. If temp, make **blocking IPC call** to create permanent chat
3. Get permanent chat ID back
4. **Update UI synchronously** (tab ID, registry, DOM)
5. **Then start streaming** with permanent ID
6. After stream, generate title (tab already has permanent ID)

## Changes Made

### 1. Added `chat:create` WebSocket Handler
**File:** `src/gateway/websocket/agent.ts`

```typescript
case "chat:create": {
  // Create a new permanent chat (like V1)
  const { v4: uuidv4 } = await import("uuid");
  const newChatId = uuidv4();
  await agentService.getStorageManager().createChat(newChatId, "New Chat");
  
  console.log(`✓ Created new chat: ${newChatId}`);
  
  sendResponse(ws, {
    id: message.id,
    success: true,
    data: { chatId: newChatId },
  });
  break;
}
```

### 2. Simplified Backend - Removed Temp Conversion
**File:** `src/gateway/services/AgentService.ts`

**Removed:**
- All temp chat detection logic (`chatId.startsWith('temp-')`)
- Permanent chat creation during streaming
- `chat-created` chunk emission
- `realChatId` variable and tracking

**Result:** Backend now expects permanent chat IDs only. Much simpler.

### 3. Simplified WebSocket Handler
**File:** `src/gateway/websocket/agent.ts`

**Removed:**
- `finalChatId` tracking
- chatId update logic in stream loop

**Result:** Simple loop that just forwards chunks, no ID tracking needed.

### 4. Refactored UI to Create Chat Before Streaming
**File:** `ui/hooks/useAgent.ts`

**New flow:**
```typescript
// V1 APPROACH: Create permanent chat BEFORE streaming if temp
if (isFirstMessage) {
  console.log("[useAgent] First message - creating permanent chat before streaming");
  const createResponse = await gateway.send("chat:create", {});
  const newChatId = (createResponse.data as any)?.chatId;
  
  // Update tab ID synchronously (like V1)
  const oldTabId = `chat-${sessionId}`;
  const newTabId = `chat-${newChatId}`;
  updateTabId(oldTabId, newTabId);
  
  chatId = newChatId; // Use permanent ID for streaming
}

// Stream with permanent chatId
await gateway.stream("agent:stream", { chatId, message, config }, ...);

// After streaming, generate title (chatId is already permanent)
if (isFirstMessage) {
  const titleResponse = await gateway.send("agent:generate-title", { chatId, message });
  const title = titleResponse.data?.title || "New Chat";
  updateTabTitle(`chat-${chatId}`, title);
}
```

**Removed:**
- `chat-created` chunk handling
- `realChatId` tracking
- Complex conditional logic

### 5. Removed `migrateChatId` from ChatStore
**File:** `ui/stores/chatStore.ts`

**Removed:**
- `migrateChatId()` method (35+ lines)
- Interface declaration for `migrateChatId`

**Result:** No complex state migration needed.

## Benefits

### Code Simplicity
- ✅ **~100 lines of code removed**
- ✅ No state migration during streaming
- ✅ No chunk type for ID conversion
- ✅ No tracking multiple ID variables
- ✅ Simpler mental model

### Reliability
- ✅ Chat ID set once, never changes
- ✅ No race conditions with ID updates
- ✅ Title generation "just works"
- ✅ Tab updates straightforward

### Performance
- ✅ No mid-stream state updates
- ✅ Fewer store updates
- ✅ Simpler React re-render logic

## Flow Comparison

### V2 (Before - Complex)
```
1. Send message with temp ID
2. Backend creates permanent ID during stream
3. Backend yields chat-created chunk
4. UI handles chunk mid-stream
5. UI calls migrateChatId()
6. UI calls updateTabId()
7. Stream continues with new ID
8. Track realChatId for title generation
9. After stream, generate title
```

### V1/V2 (After - Simple)
```
1. Check if temp chat
2. If temp: Create permanent chat (blocking)
3. Update tab ID synchronously
4. Stream with permanent ID
5. After stream, generate title
```

## Files Modified

1. `src/gateway/websocket/agent.ts` - Added `chat:create`, simplified stream handler
2. `src/gateway/services/AgentService.ts` - Removed temp conversion logic
3. `ui/hooks/useAgent.ts` - Refactored to create chat before streaming
4. `ui/stores/chatStore.ts` - Removed `migrateChatId()`

## Bug Fixes

### 1. Double "chat-" Prefix

**Issue:** Backend was returning `chat-{uuid}` instead of just `{uuid}`, causing double prefix (`chat-chat-{uuid}`) when UI added its own prefix.

**Root Cause:** `AgentService.createChat()` was using `chatId || 'chat-${uuidv4()}'` from V1's chat ID format.

**Fix:** Changed to `chatId || uuidv4()` to return just the UUID. The "chat-" prefix is only for UI tab IDs, not backend chat IDs.

**Files Modified:**
- `src/gateway/services/AgentService.ts` - Fixed `createChat()` to return UUID only
- `src/gateway/websocket/agent.ts` - Removed duplicate `chat:create` handler

### 2. Store Sync Issue (chatStore vs tabStore)

**Issue:** `activeChat` (from `chatStore`) and `activeTab` (from `tabStore`) were out of sync, causing tab lookup failures.

**Root Cause:** `ChatContainer` passed `chatStore.activeChat` to `sendMessage`, but `useAgent` used `tabStore.activeTab` for tab operations. These had different temp IDs created milliseconds apart.

**Fix:** 
1. `useAgent.sendMessage()` now gets the active tab from `tabStore` and uses its `entityId` as the chat ID (single source of truth)
2. After creating permanent chat, both stores are updated:
   - `tabStore`: Update tab ID via `updateTabId()`
   - `chatStore`: Update via `setActiveChat()` to keep stores in sync

**Files Modified:**
- `ui/hooks/useAgent.ts` - Use tab's `entityId` instead of passed `sessionId`, sync both stores

## Testing Checklist

- [ ] Send first message to new chat
- [ ] Verify permanent chat ID created before streaming starts (just UUID, no "chat-" prefix)
- [ ] Verify tab ID is `chat-{uuid}` (only one "chat-" prefix)
- [ ] Verify messages appear correctly
- [ ] Verify streaming works smoothly
- [ ] Verify chat title generates and updates tab
- [ ] Verify blue dot shows during streaming
- [ ] Verify green dot shows for unread (if switching tabs)
- [ ] Verify no console errors

---

**Date:** 2026-02-11  
**Status:** ✅ Refactored to V1 approach + Fixed double prefix bug  
**Result:** Much simpler, more reliable, easier to maintain
