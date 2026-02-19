# Final Context Management Solution

## Summary

Complete fix for "context length exceeded" errors using a **recency-based truncation strategy** across multiple layers.

## Your Questions Answered

### Q: What's the logic for truncating?
**A: Recency-based tiered truncation** - keep more context for recent tool calls, less for old ones.

### Q: Do we truncate the last tool call or previous tool calls only?
**A: We truncate all tool calls**, but with different limits based on position:
- **Last 2 tool calls:** 5KB each (most recent, keep fuller context)
- **Next 3 tool calls:** 2KB each (recent, keep moderate context)
- **Next 5 tool calls:** 1KB each (older, keep less context)
- **Remaining tool calls:** 500 chars each (very old, keep minimal context)

### Q: How do we make sure we truncate oldest vs newest first?
**A: Position-based calculation** - we count from the end of the messages array:
```typescript
const positionFromEnd = totalToolMessages - toolMessagePosition - 1;
// positionFromEnd = 0 → most recent (5KB limit)
// positionFromEnd = 10 → very old (500 char limit)
```

## Complete Architecture

### Layer 1: Tool Prevention (src/core/tools/filesystem.ts)
```typescript
// Prevent large results at source
read_file({
  path: "file.ts",
  maxSize: 50000,      // 50KB default
  offset: 1,           // Read from line N
  limit: 100           // Read N lines
})
```

**Purpose:** Stop large results before they enter context

### Layer 2: Current Turn Truncation (src/gateway/services/AgentService.ts)
```typescript
prepareStep: async (stepOptions) => {
  // Recency-based truncation during multi-step tool calling
  const positionFromEnd = totalToolMessages - position - 1;
  
  const limit = positionFromEnd < 2 ? 5000  // Most recent
    : positionFromEnd < 5 ? 2000            // Recent
    : positionFromEnd < 10 ? 1000           // Older
    : 500;                                  // Very old
}
```

**Purpose:** Truncate tool results mid-stream, prioritizing recent ones

### Layer 3: Historical Truncation (src/gateway/services/agent/historyFormatter.ts)
```typescript
// When loading from storage, use same recency strategy
const positionFromEnd = totalToolCalls - toolIndex - 1;
const limit = getHistoricalLimit(positionFromEnd);
```

**Purpose:** Protect against accumulated history, consistent with current turn

### Layer 4: Agent Guidance (src/core/agents/SystemPrompt.ts)
```
CRITICAL: File Reading Strategy
- Default limit: 50KB per file
- For large files: use offset/limit or bash
- Check size first: wc -l, ls -lh
```

**Purpose:** Teach agent to read intelligently

## Visual Example

**Conversation with 12 tool calls:**

```
Messages Array (from oldest to newest):
┌─────────────────────────────────────────────────────────────┐
│ [System] "You are Papr..."                                  │
├─────────────────────────────────────────────────────────────┤
│ [User] "Read all files in src/"                             │
├─────────────────────────────────────────────────────────────┤
│ [Assistant + Tool Call #1] read_file("file1.ts")            │
│ [Tool Result #1] 50KB → Truncated to 500 chars    (pos 11) │ ← Very old
├─────────────────────────────────────────────────────────────┤
│ [Assistant + Tool Call #2] read_file("file2.ts")            │
│ [Tool Result #2] 50KB → Truncated to 500 chars    (pos 10) │ ← Very old
├─────────────────────────────────────────────────────────────┤
│ [Assistant + Tool Call #3] read_file("file3.ts")            │
│ [Tool Result #3] 50KB → Truncated to 1KB          (pos 9)  │ ← Older
├─────────────────────────────────────────────────────────────┤
│ ...                                                          │
├─────────────────────────────────────────────────────────────┤
│ [Assistant + Tool Call #10] read_file("file10.ts")          │
│ [Tool Result #10] 50KB → Truncated to 2KB         (pos 2)  │ ← Recent
├─────────────────────────────────────────────────────────────┤
│ [Assistant + Tool Call #11] read_file("file11.ts")          │
│ [Tool Result #11] 50KB → Truncated to 5KB         (pos 1)  │ ← Most recent
├─────────────────────────────────────────────────────────────┤
│ [Assistant + Tool Call #12] read_file("file12.ts")          │
│ [Tool Result #12] 50KB → Truncated to 5KB         (pos 0)  │ ← Most recent
└─────────────────────────────────────────────────────────────┘
```

## Token Impact

### Before (No Truncation)
```
12 file reads × 50KB = 600KB = 150K tokens
Result: Context length exceeded ❌
```

### After (Equal 2KB Truncation)
```
12 file reads × 2KB = 24KB = 6K tokens
But: Recent results have same context as old ones
Quality: Suboptimal ⚠️
```

### After (Recency-Based Truncation)
```
2 very old × 500 chars = 1KB
5 older × 1KB = 5KB
3 recent × 2KB = 6KB
2 most recent × 5KB = 10KB
Total: 22KB = 5.5K tokens
Quality: Recent results have 5× more context! ✅
```

## Code Locations

1. **prepareStep (Current Turn):**
   - File: `src/gateway/services/AgentService.ts`
   - Lines: ~430-490
   - Function: `prepareStep` callback in `streamTextOptions`

2. **historyFormatter (Historical):**
   - File: `src/gateway/services/agent/historyFormatter.ts`
   - Lines: ~200-260
   - Function: `formatHistoryMessagesForModel`

3. **Tool Prevention:**
   - File: `src/core/tools/filesystem.ts`
   - Lines: ~32-44, ~55-105
   - Schema: `ReadFileSchema` and `readFile` function

4. **Agent Guidance:**
   - File: `src/core/agents/SystemPrompt.ts`
   - Lines: ~821-930
   - Function: `buildFilesystemToolsSection`

## Logs & Debugging

Tool results now include position information:

```bash
# Current turn truncation
[... 45000 chars truncated (tool result #1 from end, limit: 5000 chars)]
[... 48000 chars truncated (tool result #5 from end, limit: 2000 chars)]
[... 49500 chars truncated (tool result #10 from end, limit: 500 chars)]

# Historical truncation
[... 45000 chars truncated (historical tool #1 from end, limit: 5000)]
[... 48000 chars truncated (historical tool #5 from end, limit: 2000)]
```

Use this to debug if agent is losing important context.

## Tuning

All truncation limits are in one place for easy tuning:

```typescript
// In both AgentService.ts and historyFormatter.ts
const getTruncationLimit = (positionFromEnd: number): number => {
  if (positionFromEnd < 2) return 5000;  // Last 2
  if (positionFromEnd < 5) return 2000;  // Next 3
  if (positionFromEnd < 10) return 1000; // Next 5
  return 500;                             // Very old
};
```

**To be more conservative:** Increase limits and thresholds
**To be more aggressive:** Decrease limits, keep recent ones higher

## Future Enhancements

1. **Adaptive limits based on context pressure**
2. **Tool-specific limits** (e.g., bash vs read_file)
3. **Semantic truncation** (keep first + last for lists)
4. **Content-based prioritization** (keep referenced results)

## Testing

```bash
# 1. Type check
npm run type-check

# 2. Start app
npm start

# 3. Test with file-heavy conversation
User: "Read all TypeScript files in src/ and summarize them"

# 4. Check logs for truncation messages
# Should see different limits for different positions

# 5. Verify no context errors
# Should handle 20+ file reads without overflow
```

## Documentation

- `docs/RECENCY_TRUNCATION.md` - Detailed truncation strategy
- `docs/PREPARESTEP_FIX.md` - prepareStep discovery
- `docs/COMPLETE_CONTEXT_FIX.md` - Overall solution
- `docs/FINAL_SOLUTION.md` - This summary

## Credit

Thanks to the user for:
1. Questioning whether we could truncate mid-stream
2. Asking about recency vs equal truncation
3. Pushing for the complete solution!
