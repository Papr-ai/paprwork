# Context Length Fix Summary

## Issue
Agent was hitting "context_length_exceeded" errors during conversations with many tool calls.

## Root Cause
Tool results (up to 100KB each) were being loaded verbatim into the LLM context on every turn:
- Storage: Full 100KB result saved
- History loading: Full 100KB result loaded into context
- **Result:** With 10+ tool calls, context filled up rapidly

## Solution
Truncate tool results to 2000 chars max when loading into LLM context:

```typescript
// In historyFormatter.ts
const MAX_RESULT_CONTEXT = 2000;
const truncatedResult = resultStr.length > MAX_RESULT_CONTEXT
  ? resultStr.substring(0, MAX_RESULT_CONTEXT) + 
    `\n\n[... ${resultStr.length - MAX_RESULT_CONTEXT} chars truncated for context management]`
  : resultStr;
```

## Benefits
1. **Prevents context overflow** - Each tool result capped at 2KB in LLM context
2. **Full results preserved** - Storage still has complete results for UI display
3. **Transparent truncation** - Clear message shows how much was truncated
4. **Minimal behavioral impact** - 2KB is enough to understand most tool results

## Impact Metrics

### Before Fix
```
10 tool calls × 50KB each = 500KB
500KB ÷ 4 chars/token = 125K tokens just for tool results
Total context: ~150K tokens → Context length exceeded ❌
```

### After Fix
```
10 tool calls × 2KB each (truncated) = 20KB
20KB ÷ 4 chars/token = 5K tokens for tool results
Total context: ~30K tokens → Plenty of room ✅
```

### Token Savings
- **Per tool result:** ~45KB saved (~11K tokens)
- **Per conversation (10 tools):** ~120K tokens saved
- **Context headroom gained:** 80% reduction in tool result token usage

## Files Changed
- `src/gateway/services/agent/historyFormatter.ts` - Added truncation logic
- `docs/TOOL_RESULT_TRUNCATION_FIX.md` - Detailed documentation
- `CLAUDE.md` - Added to Known Issues section

## Testing
To verify the fix:
1. Start a conversation with many tool calls (10+)
2. Check terminal for context size logs
3. Verify no "context_length_exceeded" errors
4. Confirm UI still shows full tool results

## Related Systems

### Storage (No Change)
- Full tool results still saved (up to 100KB)
- Used for: UI display, export, debugging

### LLM Context (Changed)
- Truncated to 2KB max per tool result
- Used for: Next turn's context, understanding what happened

### Summarization (Still Needed)
- Triggered at 50K tokens (unchanged)
- Provides high-level conversation summary
- Works in conjunction with truncation

## Future Improvements
1. **Adaptive truncation** - Truncate more as context fills
2. **Smart truncation** - Keep first + last N chars
3. **Semantic truncation** - Parse JSON, keep key fields
4. **Result summarization** - Use cheap LLM to summarize large results
