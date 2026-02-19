# Tool Result Truncation Fix (2026-02-19)

## Problem

During tool-heavy conversations, the agent would hit "context length exceeded" errors because:

1. **Tool results are stored verbatim** in message history (up to 100KB each)
2. **All history is loaded into context** on every turn
3. **Tool results accumulate quickly** - with 10+ tool calls, this easily exceeds 150K tokens

Example error:
```
{
  type: 'error',
  error: {
    code: 'context_length_exceeded',
    message: 'Your input exceeds the context window of this model. Please adjust your input and try again.'
  }
}
```

## Root Cause

The issue was in `historyFormatter.ts` where tool results were loaded verbatim into the LLM context:

```typescript
// ❌ OLD (no truncation)
toolResultParts.push({
  type: "tool-result",
  toolCallId,
  toolName,
  result: typeof resultValue === "string" 
    ? resultValue 
    : JSON.stringify(resultValue)
});
```

## Solution

Truncate tool results to 2000 chars max when loading into LLM context, while keeping full results in storage:

```typescript
// ✅ NEW (truncated for context)
const MAX_RESULT_CONTEXT = 2000;
const truncatedResult = resultStr.length > MAX_RESULT_CONTEXT
  ? resultStr.substring(0, MAX_RESULT_CONTEXT) + 
    `\n\n[... ${resultStr.length - MAX_RESULT_CONTEXT} chars truncated for context management]`
  : resultStr;

toolResultParts.push({
  type: "tool-result",
  toolCallId,
  toolName,
  result: truncatedResult
});
```

## Benefits

1. **Prevents context overflow** - Tool results capped at 2000 chars each in LLM context
2. **Full results preserved** - Storage still has complete results for UI/debugging
3. **Transparent truncation** - Truncation message shows how many chars were removed
4. **No behavioral changes** - Agent still sees enough context to understand what happened

## Impact

- **Storage**: No change (full results still stored)
- **UI**: No change (full results still displayed)
- **LLM Context**: Massive reduction in token usage for tool-heavy conversations
- **Agent Behavior**: Minimal impact (2000 chars is enough to understand most tool results)

## Files Changed

- `src/gateway/services/agent/historyFormatter.ts` - Added truncation logic
- `docs/TOOL_RESULT_TRUNCATION_FIX.md` - This documentation

## Testing

To verify the fix works:

1. Start a conversation that makes many tool calls (10+)
2. Check terminal logs for context size:
   ```
   [AgentService] 📊 Context Analysis for <chatId>:
     History: X messages, ~Y tokens
   ```
3. Verify no "context_length_exceeded" errors occur
4. Check UI still shows full tool results (not truncated)

## Future Improvements

Potential enhancements:

1. **Adaptive truncation** - Truncate more aggressively as context fills up
2. **Smart truncation** - Keep first + last N chars instead of just first N
3. **Semantic truncation** - Parse JSON and keep most important fields
4. **Result summarization** - Use cheap LLM to summarize large results before storing

## Related Issues

- Tool results were previously causing context overflow in long conversations
- Summarization was triggered too late (50K token threshold)
- Context pressure monitoring (150K threshold) was a safety net, not a fix
