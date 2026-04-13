# Send Button Stuck on "Stop" After Agent Finishes

**Issue:** Send button shows "Stop" even after agent finishes streaming, when a job is still running in the background.

**Date Identified:** 2026-04-11

## Problem

User reports that when an agent finishes its response but a job is still running, the send button remains as "Stop" instead of reverting to "Send". This makes it appear as if the agent is still working when it's actually done.

## Investigation

### Flow Tracking

1. **Agent finishes** → All LLM output complete, all tools executed
2. **WebSocket handler** (line 220 in `agent.ts`) → Sends `agent:complete` message
3. **Frontend receives** (line 891 in `useAgent.ts`) → Converts to synthetic `done` chunk
4. **`handleStreamChunk` processes** (line 595-655) → Should call `setSending(chatId, false)`
5. **ChatContainer reads** (line 139-142) → `isSending` from chat state
6. **InputBar receives** (line 616) → `isSending || isWaitingForModel`

### Suspect: `setSending` Not Being Called

The most likely issue is that the `done` chunk handler (lines 595-655 in `useAgent.ts`) has a condition that prevents `setSending(chatId, false)` from being called.

Looking at the code:

```typescript
case "done":
  {
    const streamingMessageId = streamingMessageIdRef.current.get(chatId);
    if (streamingMessageId) {
      // ... finalize message ...
      
      streamingMessageIdRef.current.delete(chatId);
      streamingContentRef.current.delete(chatId);
      streamingReasoningRef.current.delete(chatId);
      toolCallsMapRef.current.delete(chatId);
      sequenceRef.current.delete(chatId);
      currentTextSegmentRef.current.delete(chatId);
    }
    activeStreamRequestByChatRef.current.delete(chatId);
    setSending(chatId, false); // ✅ Line 650
    
    // Clear streaming status (blue dot) for THIS chat's tab
    const { setTabStreaming } = useTabStore.getState();
    setTabStreaming(`chat-${chatId}`, false);
  }
  break;
```

The `setSending(chatId, false)` is called **unconditionally** after the if block, so it should always execute.

### Possible Root Causes

**Theory 1: `done` chunk not being sent**
- Check if `agent:complete` is actually sent from WebSocket handler
- Verify frontend receives it and converts to `done`

**Theory 2: State update race condition**
- `setSending` is called but immediately overridden
- Another code path sets `isSending` back to `true`

**Theory 3: Wrong `chatId` in state**
- `setSending` is called for wrong chatId
- Button reads `isSending` from different chatId

## Testing Steps

1. Add console logs to track state:

```typescript
// In useAgent.ts, line 650
console.log(`[useAgent] Setting isSending=false for chat ${chatId}`);
setSending(chatId, false);

// In ChatContainer.tsx, line 141
const isSending = useChatStore((state) => {
  const chatState = state.chatStates.get(chatId);
  console.log(`[ChatContainer] isSending for ${chatId}:`, chatState?.isSending);
  return chatState?.isSending || false;
});
```

2. Start agent task with long job
3. Wait for agent to finish (stream ends)
4. Check console logs:
   - Does `setSending=false` log appear?
   - Does `ChatContainer` show `isSending: false`?
   - Does button still show "Stop"?

## Expected vs Actual

**Expected:**
- Agent finishes → `done` chunk sent
- `setSending(chatId, false)` called
- `isSending` becomes `false`
- Button shows "Send" (enabled)

**Actual:**
- Agent finishes → `done` chunk sent (probably)
- `setSending(chatId, false)` called (probably)
- `isSending` becomes `false` (unknown)
- Button shows "Stop" ❌

## Next Steps

1. Add debugging logs to confirm state flow
2. Test with long-running job scenario
3. Verify `agent:complete` message is sent
4. Check if `isSending` state is correct but UI not updating
5. Look for other state variables affecting button display

## Related Issues

- Issue 48: Working Card Last Activity Display
- Issue 49: Message Loss on Quit During Job Execution
- Jobs running without clear UI indication
