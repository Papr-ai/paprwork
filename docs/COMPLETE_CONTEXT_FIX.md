# Complete Context Management Fix (2026-02-19)

## Your Questions & Answers

### Q1: Shouldn't truncation happen in onStepFinish for AI SDK multi-step calls?

### Q1: Shouldn't truncation happen in onStepFinish for AI SDK multi-step calls?

**YOU WERE 100% RIGHT!** After checking the AI SDK docs, we found `prepareStep` which **can modify messages mid-stream**!

The issue occurred **during** the current turn's multi-step tool calling. AI SDK accumulates context internally during the turn, and we needed to truncate **before each step**.

**Solution: `prepareStep` callback**
- Runs before each step in multi-step tool calling
- Can modify the messages array
- Perfect for truncating tool results mid-stream!

```typescript
prepareStep: async (stepOptions) => {
  const MAX_TOOL_RESULT_LENGTH = 2000;
  
  const truncatedMessages = stepOptions.messages.map((msg) => {
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      // Truncate large tool results before sending to model
      return truncateToolResults(msg);
    }
    return msg;
  });
  
  return { messages: truncatedMessages };
}
```

This is **in addition to** the historyFormatter truncation (which handles previous turns).

### Q2: Shouldn't the agent read files incrementally instead of loading the whole file?

**YES! This is the real fix!**

The problem was agents reading entire large files (50KB+) into context. We fixed this 3 ways:

#### Fix 1: Lower Default File Size Limit
- **Before:** No default maxSize (unlimited)
- **After:** 50KB default (was 10MB before)
- Fails fast with helpful error message suggesting alternatives

#### Fix 2: Add Incremental Reading
Added `offset` and `limit` parameters to `read_file`:

```typescript
// Read first 100 lines
read_file({ path: "large-file.ts", offset: 1, limit: 100 })

// Read next 100 lines
read_file({ path: "large-file.ts", offset: 101, limit: 100 })
```

#### Fix 3: Update System Prompt
Added prominent guidance teaching agents to:
1. Check file size first (`wc -l`, `ls -lh`)
2. Read incrementally (first 50-100 lines, then more if needed)
3. Use bash for targeted reading (`head`, `tail`, `grep`)
4. Use `search_files` for finding specific content

### Q3: Why don't chat .txt files show tool calls?

**You're right - they didn't!** The exporter only exported `msg.content`, not tool calls.

**Fixed:** Now exports include:
- Main content
- Thinking (for reasoning models)
- Tool calls with args
- Tool results (truncated to 500 chars each in export)

Example export format now:
```
[Assistant - 3:45 PM]
I'll read the config file

[Tool Calls]

• read_file({"path": "config.json"})
  Result: { "port": 3000, "host": "localhost" ... }
```

## What We Fixed

### 1. Tool-Level Prevention (Primary Fix)
**File:** `src/core/tools/filesystem.ts`
- Added 50KB default maxSize
- Added offset/limit for incremental reading
- Better error messages suggesting alternatives

### 2. Current Turn Truncation (CRITICAL FIX!)
**File:** `src/gateway/services/AgentService.ts` - `prepareStep`
- Truncates tool results **mid-stream** during multi-step tool calling
- Runs before each step in the agent loop
- Prevents context overflow **during the current conversation**
- This is the fix the user correctly identified we should implement!

### 3. Storage-Level Safety Net (Secondary Fix)
**File:** `src/gateway/services/agent/historyFormatter.ts`
- Truncate tool results to 2KB when loading into LLM context
- Full results preserved in storage for UI
- Clear truncation markers

### 4. Agent Guidance
**File:** `src/core/agents/SystemPrompt.ts`
- Prominent section on file reading strategy
- Examples of incremental reading
- Bash alternatives for large files

### 5. Export Completeness
**File:** `src/gateway/services/storage/ChatExporter.ts`
- Now exports tool calls and results
- Results truncated to 500 chars in export (full in SQLite)

## Impact

### Before
```
Agent reads 500KB source file
→ 500KB in current turn context (onStepFinish sees this)
→ Context length exceeded after ~5 file reads
→ Error, conversation dies
```

### After
```
Agent tries to read 500KB file
→ Tool fails with helpful error: "File too large, use offset/limit or bash"
→ Agent reads first 100 lines (5KB)
→ Context stays manageable
→ Can read 20+ files before hitting limits
```

## Token Savings

| Scenario | Before | After | Savings |
|----------|--------|-------|---------|
| Single large file read | 500KB (125K tokens) | 5KB (1.25K tokens) | ~124K tokens |
| 10 file reads | 1.25M tokens | 12.5K tokens | ~99% reduction |
| Historical turn (10 tools) | 125K tokens | 5K tokens | 96% reduction |

## Testing

To verify all fixes:

1. **Try reading a large file:**
   ```
   User: "Read src/large-file.ts"
   Agent should: Check size, read first 100 lines, ask if you want more
   ```

2. **Check exports have tool calls:**
   ```bash
   cat $PAPR_HOME/Chats/*.txt | grep "Tool Calls"
   # Should see tool calls in exported chats
   ```

3. **Verify context doesn't overflow:**
   - Have a conversation with 15+ file reads
   - Check terminal logs for token counts
   - Should stay well under 150K tokens

## Files Changed

1. `src/core/tools/filesystem.ts` - Tool-level prevention
2. `src/gateway/services/agent/historyFormatter.ts` - Storage truncation
3. `src/core/agents/SystemPrompt.ts` - Agent guidance
4. `src/gateway/services/storage/ChatExporter.ts` - Export completeness
5. `docs/TOOL_RESULT_TRUNCATION_FIX.md` - Original documentation
6. `docs/CONTEXT_LENGTH_FIX_SUMMARY.md` - Quick reference
7. `docs/COMPLETE_CONTEXT_FIX.md` - This comprehensive guide
8. `CLAUDE.md` - Updated Known Issues section

## Why All Fixes Are Needed

### Tool-Level (Primary Prevention)
- **Prevents** large results from entering context in the first place
- **Teaches** agent to read incrementally
- **Scales** to any file size
- **Best practice** - fix at the source

### Current Turn (Critical Protection)
- **Truncates** tool results **during the current conversation**
- **Protects** against multi-step tool calling overflow
- **Essential** for agent loops with many tool calls
- **This was the missing piece!**

### Storage-Level (Historical Protection)
- **Protects** against historical accumulation
- **Handles** tool results from previous turns
- **Ensures** old chats don't overflow new turns
- **Safety net** for edge cases

Together, these create **defense in depth** against context overflow.

## Future Improvements

1. **Smart truncation** - Keep first + last N chars, not just first
2. **Semantic truncation** - Parse JSON, keep most important fields
3. **Auto-detection** - Check file size, suggest offset/limit automatically
4. **Result compression** - Compress large tool results before storage
5. **Context budget** - Track cumulative tokens, warn before overflow
