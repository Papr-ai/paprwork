# Chat Streaming & Title Generation Fixes

## Issues Resolved (Feb 11, 2026)

### 1. ✅ "Unknown error" at End of Stream
**Problem**: After streaming completed successfully, the UI showed "Unknown error"

**Root Cause**: Gateway was sending `type: "agent:complete"` but the UI gateway client only recognized `response.success`

**Fix** (`ui/src/lib/gateway.ts`):
```typescript
// Now handles both completion types
if (response.type === "agent:complete" || response.success) {
  // Send final "done" chunk to UI
  onChunk({ type: "done", chatId: (response.data as any)?.chatId });
  this.handlers.delete(id);
  resolve();
}
```

### 2. ✅ Missing Chunk Payload Wrapper
**Problem**: UI expected `chunk.payload.text` but Gateway was sending `chunk.text`

**Fix** (`src/gateway/services/AgentService.ts`):
```typescript
// Wrap text in payload object
yield {
  type: 'text-delta',
  payload: { text: chunk },  // ← Added payload wrapper
  chatId,
} as any;
```

### 3. ✅ Title Generation Not Triggered
**Problem**: Chat titles remained "New Chat" instead of being auto-generated after first message

**Fix** (`ui/hooks/useAgent.ts`):
- Added logic to detect first message (temp chatId)
- Calls `agent:generate-title` WebSocket endpoint after streaming completes
- Title generated using GPT-5-mini model as specified

```typescript
if (isFirstMessage) {
  const titleResponse = await gateway.send("agent:generate-title", {
    chatId: sessionId,
    message,
  });
  const title = (titleResponse.data as any)?.title || "New Chat";
}
```

### 4. ✅ Tab Status Indicators
**Problem**: No visual feedback during streaming or for unread messages

**Fix** (`ui/hooks/useAgent.ts`):
- **Blue pulsing dot** while streaming: Set via `setTabStreaming(tab, true)` when starting
- **Green static dot** for unread: Set via `setTabUnread(tab, true)` when stream completes in background tab
- **No dot** when active/read: Cleared when tab becomes active

```typescript
// Start streaming
setTabStreaming(activeTab, true);

// On completion (done chunk)
setTabStreaming(activeTab, false);

// If not active tab
if (currentActiveTab !== activeTab) {
  setTabUnread(activeTab, true);
}
```

### 5. ✅ Error Handling & "Done" Chunk
**Problem**: No proper "done" chunk sent to UI to signal completion

**Fix** (`ui/src/lib/gateway.ts`):
- Gateway client now synthesizes a "done" chunk when `agent:complete` is received
- This triggers the UI to finalize the streaming message and clear status indicators

```typescript
else if (response.type === "agent:complete" || response.success) {
  // Synthesize done chunk
  onChunk({ type: "done", chatId: (response.data as any)?.chatId });
  this.handlers.delete(id);
  resolve();
}
```

## Complete Flow Now

### First Message Flow:
1. User types message in chat with `temp-{timestamp}-{random}` ID
2. UI sets **blue streaming dot** on tab
3. WebSocket sends `agent:stream` to Gateway
4. Gateway streams text chunks → UI displays in real-time
5. Gateway completes, sends `agent:complete` message
6. UI receives completion:
   - Clears **blue streaming dot**
   - Calls `agent:generate-title` with first message
   - Backend generates title using GPT-5-mini
   - Backend creates real chat (if temp ID)
   - UI reloads chats with new title
7. If user is on different tab: Shows **green unread dot**
8. When user switches to tab: Clears **green dot** (marks as read)

### Subsequent Messages:
- Same streaming flow
- No title generation (already has title)
- Tab indicators work the same way

## Files Modified

**Gateway:**
- `src/gateway/services/AgentService.ts` - Added payload wrapper to chunks

**UI:**
- `ui/src/lib/gateway.ts` - Handle `agent:complete` type, synthesize "done" chunk
- `ui/hooks/useAgent.ts` - Added title generation, tab status indicators
- Rebuilt: `npm run build:ui`

## Testing Checklist

- [x] Send message in new chat (temp ID)
- [x] Verify streaming appears in real-time
- [x] Verify blue dot appears during streaming
- [x] Verify title is generated after first message
- [x] Verify chatId converts from temp to permanent
- [x] Verify no "Unknown error" after completion
- [x] Send message in background tab
- [x] Verify green dot appears on that tab
- [x] Switch to that tab, verify green dot disappears
- [x] Send multiple messages in same chat
- [x] Verify title doesn't regenerate after first message

## Next Steps

All core chat features are now working:
✅ Real-time streaming with GPT-5.2 reasoning models
✅ Automatic title generation
✅ Tab status indicators (blue streaming, green unread)
✅ Temp → permanent chatId conversion
✅ Error handling and completion signaling

**Ready for Production Testing!** 🚀
