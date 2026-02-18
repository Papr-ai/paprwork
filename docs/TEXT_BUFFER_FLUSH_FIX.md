# Text Buffer Flush Fix

**Date:** 2026-02-17  
**Issue:** Agent responses were being split incorrectly between tool calls

## Problem

The agent's text responses were being cut in half when tool calls occurred:

**Backend (correct):**
```
"Now let me write the complete new CSS with Liquid Glass properly"
[tool call]
```

**UI (incorrect):**
```
"Now let me write the complete"
[tool call]
"new CSS with Liquid Glass properly"
```

## Root Cause

In `src/gateway/services/agent/streamOrchestrator.ts`, there's a text buffering mechanism that accumulates text chunks and only sends them to the UI when the buffer reaches 50 characters (`TEXT_BUFFER_MIN`).

The issue was that when interrupting events occurred (tool calls, reasoning), the code did NOT flush the accumulated text buffer before yielding the interrupting event. This caused:

1. Text accumulates: "Now let me write the complete new CSS with Liquid Glass properly"
2. Buffer hits 50 chars → yields "Now let me write the complete"  
3. Tool call arrives → yields tool call chunk (without flushing buffer first!)
4. Remaining text "new CSS with Liquid Glass properly" in buffer → yields later after tool result

## Solution

Added explicit buffer flushing before interrupting events in three locations:

### 1. Before Tool Calls (lines 139-145)
```typescript
case "tool-call": {
  const toolCall = parseToolCallChunk(rawChunk);
  if (!toolCall) break;

  toolCalls.push(toolCall);
  
  // CRITICAL: Flush text buffer to UI before tool call
  if (textBuffer.length > 0) {
    console.log(`[StreamOrchestrator] Flushing text buffer (${textBuffer.length} chars) before tool call`);
    yield createChatStreamChunk("text-delta", { text: textBuffer }, chatId);
    textBuffer = "";
  }
  // ... rest of tool-call handling
}
```

### 2. Before Reasoning (lines 89-97)
```typescript
case "reasoning-start": {
  console.log("[AgentService] Reasoning started");
  // Flush text buffer before reasoning starts
  if (textBuffer.length > 0) {
    console.log(`[StreamOrchestrator] Flushing text buffer (${textBuffer.length} chars) before reasoning`);
    yield createChatStreamChunk("text-delta", { text: textBuffer }, chatId);
    textBuffer = "";
  }
  break;
}
```

### 3. At Text End (lines 74-87)
```typescript
case "text-end": {
  // Flush any remaining text buffer to ensure UI gets complete text before tool call
  if (textBuffer.length > 0) {
    console.log(`[StreamOrchestrator] Flushing text buffer (${textBuffer.length} chars) at text-end`);
    yield createChatStreamChunk("text-delta", { text: textBuffer }, chatId);
    textBuffer = "";
  }
  // ... rest of text-end handling
}
```

## Impact

- ✅ Text is no longer split around tool calls
- ✅ UI displays complete sentences before tool execution
- ✅ Better user experience with proper text flow
- ✅ Maintains buffering optimization (50 char threshold for efficiency)
- ✅ No impact on performance (only adds flush when needed)

## Testing

To verify the fix works:

1. Start the app: `npm start`
2. Send a message that triggers tool calls with narration before them
3. Verify that all text before a tool call appears together in the UI
4. Check browser console for flush logs: `[StreamOrchestrator] Flushing text buffer`

## Related Files

- `src/gateway/services/agent/streamOrchestrator.ts` - Stream chunk processor (fixed)
- `src/gateway/services/AgentService.ts` - Main agent service (no changes)
- `ui/hooks/useChat.ts` - UI chat hook (no changes)

## Lessons Learned

1. **Buffer Management:** When implementing buffering for performance, always flush before context switches
2. **Stream Interruptions:** Any event that interrupts text flow (tool calls, reasoning, etc.) should trigger a buffer flush
3. **Debugging Streams:** Add detailed logging to understand chunk ordering and buffer state
4. **Testing Stream Edge Cases:** Test scenarios with:
   - Short text before tool calls (< 50 chars)
   - Long text before tool calls (> 50 chars)
   - Multiple tool calls in sequence
   - Interleaved reasoning and tool calls
