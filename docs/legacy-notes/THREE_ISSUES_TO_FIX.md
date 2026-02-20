# Three Critical Issues to Fix

## Issue 1: Tab Persistence Not Working

**Problem**: App shows "no tab selected" on relaunch instead of restoring the last active tab.

**Status**: Hydration fix was implemented but may not be working correctly.

**Debug Steps**:
1. Open browser DevTools console (Cmd+Option+I)
2. Look for these logs on app start:
   ```
   [App] ✅ Tab store hydrated from localStorage
   [App.useEffect] Current activeTabId: chat-xxxxx
   ```
3. If you see `activeTabId: null` or `activeTabId: undefined`, the persistence isn't working

**Possible Causes**:
- LocalStorage is being cleared
- Zustand persist middleware isn't saving correctly
- Timing issue with hydration

**Quick Test**:
```javascript
// In browser console:
localStorage.getItem('tab-store')
// Should show: {"state":{"tabs":[...],"activeTabId":"chat-...",...},"version":0}
```

---

## Issue 2: Messages with Only Thinking/Tools Not Showing in History

**Problem**: If an assistant response has thinking and tool calls but NO text content, it doesn't show in message history.

**Root Cause**: Messages are likely not being saved when `content` is empty.

**Current Behavior**:
- Streaming works fine (shows thinking + tool calls)
- But after refresh, message disappears from history
- MessageItem.tsx DOES support rendering without text content (lines 83-96)

**Fix Needed**: Check `useAgent.ts` message saving logic:

```typescript
// In the "done" chunk handler, we need to save even if assistantText is empty
if (streamingMessageIdRef.current) {
  const finalMessage: ChatMessage = {
    id: streamingMessageIdRef.current,
    role: "assistant",
    content: streamingContentRef.current || "", // ← Should be empty string, not undefined
    reasoning: streamingReasoningRef.current || undefined,
    toolCalls: Array.from(toolCallsMapRef.current.values()),
    // ... other fields
  };
  
  // MUST save even if content is empty!
  await updateMessage(chatId, finalMessage);
}
```

**Verification**:
```javascript
// Check message storage:
window.electronAPI.agent.getHistory('chat-xxxxx')
// Should include messages with toolCalls even if content is ""
```

---

## Issue 3: 20 Steps Limit - LLM Has No Awareness

**Problem**: When the agent hits the 20-step limit, it stops abruptly (potentially mid-tool-execution) without a text response.

**Current Implementation**:
```typescript
stopWhen: (options) => options.steps.length >= 20
```

**What Happens**:
1. Agent executes 19 steps (tool calls + responses)
2. On step 20, streaming just **stops**
3. LLM has NO idea it's at the limit
4. No graceful finish or text response

**Solution Options**:

### Option A: Much Higher Limit (Recommended)
```typescript
stopWhen: (options) => options.steps.length >= 100
```
- **Pro**: LLM naturally completes before hitting limit
- **Pro**: Handles complex multi-tool workflows
- **Con**: Risk of infinite loops (but rare with good prompts)

### Option B: Smart Stop Condition
```typescript
stopWhen: (options) => {
  // Stop if we've done 20 steps AND the last step was NOT a tool call
  if (options.steps.length >= 20) {
    const lastStep = options.steps[options.steps.length - 1];
    // If last step was a tool-result, allow one more step for text response
    return lastStep.type !== 'tool-result';
  }
  return false;
}
```
- **Pro**: Ensures LLM gets a chance to respond after tools
- **Con**: More complex logic
- **Con**: Could still hit limit if LLM keeps calling tools

### Option C: Post-Processing
```typescript
// After streaming completes, check if we hit the limit
if (options.steps.length >= 20 && !assistantText) {
  // Add a system message explaining what happened
  assistantText = "[Response truncated after 20 steps. The agent executed multiple tool calls but didn't provide a final response.]";
}
```
- **Pro**: User always knows what happened
- **Con**: Not a real LLM response

### Option D: No Limit (Not Recommended)
```typescript
// Remove stopWhen entirely
// Default AI SDK behavior is infinite loop until no more tool calls
```
- **Pro**: Most flexible
- **Con**: Risk of runaway costs
- **Con**: Could hang indefinitely

---

## Recommendations

### For Issue 1 (Tab Persistence):
Check browser console logs to diagnose. If localStorage is empty, the persist middleware isn't working.

### For Issue 2 (Message History):
Fix the "done" chunk handler in `useAgent.ts` to save messages even when `content` is empty string.

### For Issue 3 (20 Steps):
**Go with Option A: Increase to 100 steps**

Reasoning:
- Modern LLMs are smart enough to stop naturally
- Complex tasks legitimately need many tool calls
- The risk of infinite loops is very low with good system prompts
- If we hit 100 steps, that's a genuine edge case worth investigating

```typescript
stopWhen: (options) => options.steps.length >= 100
```

**Add safety**: If concerned about runaway, add timeout:
```typescript
const result = await streamText({
  model,
  messages,
  tools,
  stopWhen: (options) => options.steps.length >= 100,
  timeout: { totalMs: 5 * 60 * 1000 }, // 5 minutes max for entire generation
  abortSignal: abortController.signal,
});
```

This gives 5 minutes total time, which is more than enough for any reasonable workflow but prevents infinite hangs.

---

## Priority

1. **Issue 3 (Steps Limit)** - Blocking core functionality ✅ FIX FIRST
2. **Issue 2 (Message History)** - Poor UX, losing conversation context
3. **Issue 1 (Tab Persistence)** - Annoying but has workaround (create new tab)

---

## Implementation Order

1. **Quick Win**: Change 20 → 100 steps (1 line change)
2. **Debug**: Check console logs for tab persistence issue
3. **Fix**: Message saving logic for messages without text content
