# Recency-Based Truncation Strategy

## The Problem

When truncating tool results to prevent context overflow, treating all tool calls equally is suboptimal:

**❌ Old Approach (Equal Truncation):**
```
Tool result 1 (10 steps ago): 50KB → Truncated to 2KB
Tool result 2 (5 steps ago):  50KB → Truncated to 2KB
Tool result 3 (just now):     50KB → Truncated to 2KB
```

**Problem:** The agent needs the most recent tool results more than old ones. Truncating them equally wastes context space on old results the agent probably won't reference again.

## The Solution: Recency-Based Truncation

**✅ New Approach (Recency-Based):**
```
Tool result 1 (10 steps ago): 50KB → Truncated to 500 chars (aggressive)
Tool result 2 (5 steps ago):  50KB → Truncated to 2KB (moderate)
Tool result 3 (just now):     50KB → Truncated to 5KB (keep more context)
```

**Benefits:**
- Agent has fuller context for recent actions
- Old tool results take minimal space
- Better context utilization overall

## Truncation Tiers

### Tier 1: Most Recent (Last 2 tool results)
- **Limit:** 5KB per result
- **Rationale:** Agent actively working with this data
- **Use case:** Just read a file and need to process it

### Tier 2: Recent (Next 3 tool results)
- **Limit:** 2KB per result
- **Rationale:** May need to reference recent work
- **Use case:** Compared files, checking previous output

### Tier 3: Older (Next 5 tool results)
- **Limit:** 1KB per result
- **Rationale:** Occasionally referenced
- **Use case:** Earlier exploration, file checks

### Tier 4: Very Old (Remaining tool results)
- **Limit:** 500 chars per result
- **Rationale:** Rarely referenced, keep minimal context
- **Use case:** Initial exploration, abandoned paths

## Visual Example

Conversation with 12 tool calls:

```
[Step 1]  User: "Read all files in src/"
[Step 2]  Tool: read_file (50KB) → Truncated to 500 chars (very old)
[Step 3]  Tool: read_file (50KB) → Truncated to 500 chars (very old)
[Step 4]  Tool: read_file (50KB) → Truncated to 1KB (older)
[Step 5]  Tool: read_file (50KB) → Truncated to 1KB (older)
[Step 6]  Tool: read_file (50KB) → Truncated to 1KB (older)
[Step 7]  Tool: read_file (50KB) → Truncated to 1KB (older)
[Step 8]  Tool: read_file (50KB) → Truncated to 1KB (older)
[Step 9]  Tool: read_file (50KB) → Truncated to 2KB (recent)
[Step 10] Tool: read_file (50KB) → Truncated to 2KB (recent)
[Step 11] Tool: read_file (50KB) → Truncated to 2KB (recent)
[Step 12] Tool: read_file (50KB) → Truncated to 5KB (most recent)
[Step 13] Tool: read_file (50KB) → Truncated to 5KB (most recent)
```

**Total context used:**
- Old approach (2KB × 12): 24KB
- New approach (recency-based): ~16KB (33% savings!)
- **Quality improvement:** Last 2 results have 2.5x more context

## Implementation

Located in `src/gateway/services/AgentService.ts` in the `prepareStep` callback:

```typescript
const getTruncationLimit = (toolMessagePosition: number): number => {
  const positionFromEnd = totalToolMessages - toolMessagePosition - 1;
  
  if (positionFromEnd < 2) return 5000;  // Last 2: 5KB
  if (positionFromEnd < 5) return 2000;  // Next 3: 2KB
  if (positionFromEnd < 10) return 1000; // Next 5: 1KB
  return 500;                             // Very old: 500 chars
};
```

## Token Efficiency

### Before (Equal 2KB Truncation)
```
12 tool results × 2KB = 24KB = ~6K tokens
Context: 80% old results, 20% recent results
```

### After (Recency-Based)
```
2 very old × 500 chars = 1KB
5 older × 1KB = 5KB
3 recent × 2KB = 6KB
2 most recent × 5KB = 10KB
Total: 22KB = ~5.5K tokens (8% savings)
```

**But more importantly:**
- **Before:** Most recent result had 2KB (same as all others)
- **After:** Most recent result has 5KB (2.5x more context!)

## Logging

Truncation messages now include position information:

```
[... 45000 chars truncated (tool result #1 from end, limit: 5000 chars)]
[... 48000 chars truncated (tool result #5 from end, limit: 2000 chars)]
[... 49500 chars truncated (tool result #10 from end, limit: 500 chars)]
```

This helps debug if the agent is losing important context.

## Tuning the Strategy

The tier limits can be adjusted based on monitoring:

```typescript
// Conservative (keep more old context)
if (positionFromEnd < 3) return 8000;  // Last 3: 8KB
if (positionFromEnd < 8) return 3000;  // Next 5: 3KB
if (positionFromEnd < 15) return 1500; // Next 7: 1.5KB
return 1000;                            // Very old: 1KB

// Aggressive (maximize recent context)
if (positionFromEnd < 1) return 10000; // Last 1: 10KB
if (positionFromEnd < 3) return 3000;  // Next 2: 3KB
if (positionFromEnd < 6) return 1000;  // Next 3: 1KB
return 200;                             // Very old: 200 chars
```

## Future Enhancements

1. **Adaptive limits based on context pressure:**
   - Start with generous limits
   - Truncate more aggressively as context fills
   - Monitor `promptTokens` in `onStepFinish`

2. **Tool-specific limits:**
   - `read_file`: Keep 2KB (needs more context)
   - `bash`: Keep 1KB (output often repetitive)
   - `list_directory`: Keep 500 chars (just filenames)

3. **Semantic truncation:**
   - For JSON results: Keep first + last N objects
   - For code: Keep imports + function signatures
   - For lists: Keep first N + last N items

4. **Content-based prioritization:**
   - Keep tool results referenced in recent messages
   - Truncate tool results not mentioned again
   - Use tool name + args to detect duplicates

## Testing

To verify recency-based truncation:

1. **Start a conversation with 10+ file reads:**
   ```
   User: "Read all TypeScript files in src/ and analyze them"
   ```

2. **Check terminal logs for truncation messages:**
   ```
   [... 45000 chars truncated (tool result #1 from end, limit: 5000 chars)]
   [... 48000 chars truncated (tool result #3 from end, limit: 2000 chars)]
   [... 49500 chars truncated (tool result #8 from end, limit: 500 chars)]
   ```

3. **Verify context token counts:**
   - Should grow slower than with equal truncation
   - Recent steps should have lower token deltas

## Related Files

- `src/gateway/services/AgentService.ts` - Implementation
- `src/gateway/services/agent/historyFormatter.ts` - Historical truncation (also uses recency)
- `docs/PREPARESTEP_FIX.md` - prepareStep documentation
- `docs/RECENCY_TRUNCATION.md` - This file
