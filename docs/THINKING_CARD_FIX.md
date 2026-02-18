# Thinking Card Display Fix

**Date:** 2026-02-17  
**Issue:** Claude thinking tokens not showing in UI despite reasoning-start/reasoning-end in backend

## Problem

Backend logs showed:
```
[AgentService] Reasoning started
[AgentService] Received chunk type: reasoning-delta
[AgentService] Reasoning ended
```

But the UI didn't show the ThinkingCard for Claude's extended thinking.

## Root Cause

The `renderSequence` function only checked for thinking **in the sequence** (which is added at `reasoning-end`), but didn't check for **streaming thinking** that's still accumulating.

### Existing Logic (INCOMPLETE)

```typescript
// Only renders thinking from sequence (after reasoning-end)
if (hasThinking) {
  const thinkingItem = sequence.find(item => item.type === 'thinking');
  if (thinkingItem) {
    elements.push(<ThinkingCard content={thinkingItem.data} isStreaming={false} />);
  }
}
```

### Missing Case

During streaming, thinking is stored in `message.streamingReasoning` and NOT yet in the sequence:

```typescript
// useAgent.ts (line 117)
streamingReasoning: streamingReasoningRef.current.get(chatId) || "",
```

The sequence only gets thinking added at `reasoning-end` (line 127-128 of `streamOrchestrator.ts`).

## Solution

Added fallback to render streaming thinking if it's not in sequence yet:

```typescript
// Extract thinking from sequence OR streaming state (show at top)
if (hasThinking) {
  const thinkingItem = sequence.find(item => item.type === 'thinking');
  if (thinkingItem && typeof thinkingItem.data === 'string') {
    elements.push(
      <ThinkingCard
        key="thinking"
        content={thinkingItem.data}
        isStreaming={false}
      />
    );
  }
} else if (reasoning && reasoning.trim()) {
  // Thinking is still streaming (not in sequence yet)
  elements.push(
    <ThinkingCard
      key="thinking"
      content={reasoning}
      isStreaming={message.isStreaming}
    />
  );
}
```

Where `reasoning` is:
```typescript
const reasoning = message.isStreaming
  ? message.streamingReasoning || message.reasoning
  : message.reasoning;
```

## How It Works Now

### During Streaming
1. `reasoning-delta` chunks arrive
2. Accumulated in `message.streamingReasoning`
3. ThinkingCard renders with `isStreaming={true}` (shows cursor)
4. Updates live as more reasoning arrives

### After Reasoning Ends
1. `reasoning-end` event triggers
2. Thinking added to sequence: `{ type: 'thinking', data: thinkingText }`
3. ThinkingCard continues rendering from sequence
4. Shows with `isStreaming={false}` (no cursor)

## Files Changed

- `ui/components/Chat/MessageItem.tsx` (lines 61-86)
  - Added reasoning variable from streamingReasoning
  - Added else-if to render streaming thinking

## Testing

To verify the fix:

1. Use Claude model with extended thinking
2. Give a complex task that triggers reasoning
3. Watch for ThinkingCard to appear during streaming
4. Verify it shows:
   - Random thinking phrase ("Pondering...", "Ruminating...", etc.)
   - Streaming content with cursor
   - Auto-collapses when complete

## Related Components

- `ui/components/Chat/ThinkingCard.tsx` - Component itself (no changes)
- `ui/hooks/useAgent.ts` - Accumulates streamingReasoning (no changes)
- `src/gateway/services/agent/streamOrchestrator.ts` - Adds thinking to sequence (no changes)

## Why This Pattern

**Two sources of thinking:**
1. **Streaming state** - Live updates during streaming (`message.streamingReasoning`)
2. **Sequence** - Final version after completion (`sequence.find(item => item.type === 'thinking')`)

The UI needs to handle both:
- During streaming → Use streamingReasoning
- After completion → Use sequence (more reliable, part of persistent message)

## Lessons Learned

1. **Dual rendering paths** - Both fallback and sequence paths need same features
2. **Streaming vs final state** - Check both streaming fields and sequence
3. **Test with thinking models** - Claude Extended Thinking, GPT-5 Reasoning
4. **Visual feedback matters** - Users want to see the agent thinking, not just final output
