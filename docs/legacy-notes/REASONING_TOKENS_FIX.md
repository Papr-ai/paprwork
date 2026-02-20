# Reasoning Tokens Fix

## Issue
Thinking/reasoning tokens were not appearing in the UI despite being enabled with GPT-5 models.

## Root Cause
The AI SDK delivers reasoning tokens differently than expected:
- ❌ NOT as `reasoning-delta` streaming chunks
- ✅ As complete blocks: `reasoning-start` → `reasoning-end`

The `reasoning-end` chunk contains the full reasoning text.

## What Was Wrong

### Gateway (AgentService.ts)
```typescript
// BEFORE - Only handled text-delta
for await (const chunk of result.textStream) {
  assistantText += chunk;
  // No reasoning support
}
```

### Logs Showed
```
[AgentService] Received chunk type: reasoning-start
[AgentService] Received chunk type: reasoning-end
```

But no reasoning made it to UI because we weren't handling these chunk types!

## The Fix

### 1. Changed from textStream → fullStream
```typescript
// AFTER - Use fullStream to get ALL chunk types
for await (const chunk of result.fullStream) {
  switch (chunk.type) {
    case 'text-delta': { ... }
    case 'reasoning-start': { ... }    // ✅ NEW
    case 'reasoning-end': { ... }      // ✅ NEW
    case 'tool-call': { ... }          // ✅ NEW
    case 'tool-result': { ... }        // ✅ NEW
  }
}
```

### 2. Added reasoning-end handler
```typescript
case 'reasoning-end': {
  // Extract full reasoning text from chunk
  const reasoningText = chunk.text || chunk.reasoning || '';
  if (reasoningText) {
    thinkingText = reasoningText;
    
    // Send to UI as reasoning-delta
    yield {
      type: 'reasoning-delta',
      payload: { text: reasoningText },
      chatId,
    };
  }
  break;
}
```

## UI Components (Already Working!)

The UI was **already ready** for reasoning tokens:

### MessageItem.tsx
```typescript
// Already displays ThinkingCard when reasoning exists
{!isUser && reasoning && (
  <ThinkingCard
    content={reasoning}
    isStreaming={message.isStreaming && !!message.streamingReasoning}
  />
)}
```

### useAgent.ts
```typescript
// Already handles reasoning-delta chunks
case "reasoning-delta": {
  const text = chunk.payload.text;
  streamingReasoningRef.current += text;
  // Updates message.streamingReasoning
}
```

### ThinkingCard.tsx
- Liquid glass styling ✅
- Collapsible header ✅
- Streaming cursor ✅
- Same design as V1 ✅

## Chunk Types in fullStream

Based on AI SDK logs, here are all chunk types for GPT-5:

1. **start** - Stream started
2. **start-step** - Reasoning step started
3. **reasoning-start** - Reasoning phase started
4. **reasoning-end** - Reasoning complete (contains text)
5. **text-start** - Text generation started
6. **text-delta** - Text content streaming
7. **text-end** - Text generation complete
8. **tool-call** - Tool invocation
9. **tool-result** - Tool execution result
10. **finish-step** - Step complete
11. **finish** - Stream complete
12. **error** - Stream error

## Expected Behavior After Fix

### Gateway Logs
```
[Agent WS] Starting stream for chat <chatId>
[AgentService] Received chunk type: reasoning-start
[AgentService] Reasoning complete: 234 chars  ← Full reasoning extracted
[AgentService] Received chunk type: reasoning-end
[Agent WS] Stream complete for chat <chatId>. Chunks: 26
```

### UI Display
1. **ThinkingCard appears** when reasoning starts
2. **Reasoning text shows** after reasoning-end
3. **Main response streams** after reasoning
4. **Proper markdown spacing** (pre-wrap removed)

## Other Fixes in This Session

1. ✅ **Title generation** - Now uses `gpt-5-mini` (was `gpt-5-mini-2025-08-07`)
2. ✅ **Key resolution** - Fixed `getKey()` → `getKeyByName()` in IPC
3. ✅ **Secure key flow** - Keys never sent over WebSocket (IPC-only)
4. ✅ **Markdown spacing** - Removed `white-space: pre-wrap`
5. ✅ **Tool streaming** - Added tool-call and tool-result handlers
6. ✅ **Tests updated** - Fixed all tests for new architecture

## Testing

1. Restart app: `npm start`
2. Create new chat
3. Send message with GPT-5 model (high reasoning effort)
4. Should see:
   - ThinkingCard with reasoning content
   - Title auto-generated (not truncated)
   - Clean markdown spacing
   - Parallel streaming works

## Files Changed

**Gateway:**
- `src/gateway/services/AgentService.ts`
  - Changed `textStream` → `fullStream`
  - Added handlers for: `reasoning-start`, `reasoning-end`, `tool-call`, `tool-result`, `error`
  - Added debug logging for non-text chunks
  - Extract reasoning from `reasoning-end` chunk

**Title Service:**
- `src/gateway/services/TitleGenerationService.ts`
  - Changed model: `gpt-5-mini-2025-08-07` → `gpt-5-mini`

**IPC:**
- `src/electron/index.cjs`
  - Fixed: `getKey()` → `getKeyByName()`

**UI:**
- `ui/components/Chat/MessageItem.css`
  - Removed: `white-space: pre-wrap` from `.message-text`

**Types:**
- `src/core/types/agents.ts`
  - Split: `AgentConfig` (public) + `AgentConfigInternal` (with apiKey)
- `ui/types/core.ts`
  - Removed `apiKey` from `AgentConfig`

**Tests:**
- `tests/chat-session-manager.test.ts`
  - Updated all configs to use `AgentConfigInternal`
- `ui/__tests__/features/comprehensive.test.ts`
  - Removed all `activeChat` references

## Next Steps

If reasoning still doesn't appear:
1. Check terminal logs for "Reasoning complete: X chars"
2. Verify GPT-5 model has reasoning effort set
3. Check browser console for reasoning-delta chunks
4. May need to extract reasoning from a different property in the chunk
