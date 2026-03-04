# Multi-Step Streaming Fix

**Date:** 2026-03-04  
**Issue:** Multiple "Working/Thinking" cards displayed for single assistant response

## Problem

When using multi-step tool calling (AI SDK's `maxSteps` parameter), the frontend was creating **multiple assistant message UI cards** for a single response instead of consolidating them into one card.

### Root Cause

The AI SDK's `streamText` function supports multi-step tool calling via the `maxSteps` parameter (default: 100). Each tool iteration produces:
- `start-step` chunk
- Tool execution chunks (`tool-call`, `tool-result`)
- `finish-step` chunk with token usage

The `streamOrchestrator.ts` was yielding a **`done` chunk** after each `finish-step` (line 448-458), which triggered the frontend's finalization logic prematurely:

```typescript
// streamOrchestrator.ts (BEFORE FIX)
case "finish-step": {
  if (finishStepChunk.usage) {
    yield createChatStreamChunk("done", { usage }, chatId); // ❌ WRONG!
  }
}
```

The frontend's `done` handler (`useAgent.ts` line 585-648) would:
1. Finalize the current streaming message
2. **Delete `streamingMessageIdRef.current`** (line 635)
3. Clear all streaming state

When the NEXT `start-step` arrived for tool step 2, the check at line 93-98 would fail (no streaming message ref), creating a **NEW assistant message** instead of continuing the existing one.

### Evidence

**Database query showed multiple messages with same user context:**
```bash
$ sqlite3 ~/.paprwork-v2/chats.db "SELECT id, timestamp, substr(content, 1, 80) FROM messages WHERE chat_id = '...' AND role = 'assistant' ORDER BY timestamp DESC LIMIT 2;"

msg-81da314e|2026-03-04T07:17:49.557Z|Got it — no deletions...
msg-b540ceb3|2026-03-04T07:17:17.974Z|I don't have direct access to execute curl...
```

**Terminal logs showed "Saving message" after each `finish-step`:**
```
[AgentService] Received chunk type: finish-step
[LocalStorage] Saving message to chat cc5dfae6-...
[AgentService] Received chunk type: finish-step  
[LocalStorage] Saving message to chat cc5dfae6-...
```

## Solution

Changed `finish-step` to yield **`step-usage`** instead of `done`:

```typescript
// streamOrchestrator.ts (AFTER FIX)
case "finish-step": {
  if (finishStepChunk.usage) {
    yield createChatStreamChunk("step-usage", { usage }, chatId); // ✅ CORRECT
  }
}
```

### Changes Made

1. **`src/gateway/services/agent/streamOrchestrator.ts`**:
   - Changed `finish-step` to yield `step-usage` instead of `done`
   - Added comment explaining why (prevent premature finalization)

2. **`src/gateway/services/AgentService.ts`**:
   - Updated token usage extraction to handle both `done` AND `step-usage` chunks
   - ```typescript
     if (next.value.type === "done" || next.value.type === "step-usage") {
       // Extract usage...
     }
     ```

3. **`src/core/types/streaming.ts`**:
   - Added `step-usage` to `StreamChunkType` union

4. **`ui/hooks/useAgent.ts`**:
   - No changes needed! Unknown chunk types (like `step-usage`) are silently ignored (fall through switch default)

## Complete Flow After Fix

### Multi-Step Tool Calling (3 steps example)

```
┌─────────────────────────────────────────────────────────────┐
│ Step 1: First tool call                                      │
├─────────────────────────────────────────────────────────────┤
│ start-step → text-delta → tool-call → tool-result →         │
│ finish-step → yield step-usage                               │
│   ↓                                                          │
│   Frontend: Continues streaming (no finalization)            │
│   Backend: Tracks token usage, NO save yet                   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Step 2: Second tool call                                     │
├─────────────────────────────────────────────────────────────┤
│ start-step → text-delta → tool-call → tool-result →         │
│ finish-step → yield step-usage                               │
│   ↓                                                          │
│   Frontend: STILL streaming same message (no finalization)   │
│   Backend: Updates token usage, NO save yet                  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Step 3: Final text (no more tools)                          │
├─────────────────────────────────────────────────────────────┤
│ start-step → text-delta → finish                            │
│   ↓                                                          │
│   orchestrateModelStream: Generator RETURNS (doesn't yield)  │
│   ↓                                                          │
│   AgentService: next.done === true → Save message ONCE       │
│   ↓                                                          │
│   WebSocket: Sends agent:complete with finalMessage          │
│   ↓                                                          │
│   Frontend: Receives done chunk → Finalization happens ONCE  │
└─────────────────────────────────────────────────────────────┘
```

### Key Points

- **`step-usage` chunks**: Used by backend for token tracking, ignored by frontend
- **Only ONE `done` chunk**: Sent by websocket AFTER all steps complete
- **Only ONE message saved**: After `AgentService` loop completes
- **Only ONE UI card**: Frontend doesn't finalize until final `done`

## Testing

After deploying the fix:

1. Start a conversation that requires multiple tool calls
2. Observe the UI: Should show **one** "Working on it..." card that updates with all thinking/tools/text
3. Check database: Should have **one** assistant message per user message
4. Check terminal logs: Should see "Saving message" **once** at the end, not after each step

## Related Files

- `src/gateway/services/agent/streamOrchestrator.ts` - Stream chunk orchestration
- `src/gateway/services/AgentService.ts` - Agent streaming logic
- `src/core/types/streaming.ts` - Streaming type definitions
- `ui/hooks/useAgent.ts` - Frontend streaming state management
- `src/gateway/websocket/agent.ts` - WebSocket message handling

## Prevention

To prevent similar issues:

1. **Never yield `done` for intermediate events** - Reserve `done` for final completion only
2. **Test multi-step scenarios** - Use tools that require 3+ iterations
3. **Check message count** - `SELECT COUNT(*) FROM messages WHERE role = 'assistant'` after each test
4. **Monitor logs** - "Saving message" should only appear once per assistant response

## Lessons Learned

1. **Chunk types matter**: Using generic types like `done` for intermediate events can cause premature state cleanup
2. **Multi-step is common**: AI SDK's `maxSteps` default is 100, so this affects most tool-heavy conversations
3. **Frontend/backend coordination**: Both sides must agree on chunk semantics (what triggers finalization)
4. **Testing tool calling**: Always test with 3+ sequential tool calls to catch multi-step issues
