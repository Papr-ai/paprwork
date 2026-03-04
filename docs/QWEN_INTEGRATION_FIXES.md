# Qwen 3.5 Integration Fixes Summary

**Date:** 2026-03-04  
**Models:** Qwen 3.5 9B via Ollama

## Issues Fixed

This document summarizes two critical fixes for Qwen 3.5 integration with Paprwork V2.

---

## Fix #1: Multi-Step Streaming UI Issue

### Problem
Multiple "Working/Thinking" cards appearing for a single assistant response when using multi-step tool calling.

### Root Cause
The AI SDK's `finish-step` chunk was yielding a `done` chunk after each tool iteration, causing:
1. Frontend to finalize the current message
2. Clear the streaming message reference
3. Create a NEW message for the next tool step

### Solution
Changed `finish-step` to yield `step-usage` instead of `done`:

```typescript
// streamOrchestrator.ts (BEFORE)
case "finish-step": {
  yield createChatStreamChunk("done", { usage }, chatId); // ❌ Wrong!
}

// streamOrchestrator.ts (AFTER)
case "finish-step": {
  yield createChatStreamChunk("step-usage", { usage }, chatId); // ✅ Correct!
}
```

### Result
- **One** "Working on it..." card per assistant response
- **One** database entry per response
- Clean, consolidated streaming experience

**Full documentation:** `docs/MULTI_STEP_STREAMING_FIX.md`

---

## Fix #2: Context Window / Tool Truncation Issue

### Problem
Qwen only seeing 15 out of 70 tools:
- ✅ Seeing: Delegation, planning, API key management
- ❌ Missing: bash, filesystem, browser, and most core tools

### Root Cause
**Ollama's default `num_ctx` is 4096 tokens**, far too small for Paprwork's tool suite:

```
Tool schemas: ~8,549 tokens (70 tools)
System prompt: ~2,000 tokens
Conversation: ~5,000 tokens
─────────────────────────────
Total prompt: ~11,483 tokens → TRUNCATED to 4,096!
```

**Evidence:**
```
[Ollama] level=WARN msg="truncating input prompt" limit=4096 prompt=11483 keep=4 new=4096
```

### Solution
Set `num_ctx: 32768` in Ollama provider options:

```typescript
// AgentService.ts
if (config.provider === "ollama") {
  providerOptions.ollama = {
    think: true,
    options: {
      num_ctx: 32768, // Qwen 3.5 supports up to 128K
    },
  };
}
```

### Why 32K?
- **Tool schemas**: 8.5K tokens
- **Conversation history**: 5-10K tokens
- **Thinking + responses**: 5-10K tokens
- **Safety margin**: 2x buffer
- **32K provides comfortable headroom** without exhausting Qwen's 128K limit

### Result
- Qwen now sees **all 70 tools**
- Can successfully use core tools (bash, filesystem, browser)
- No more truncation warnings in logs

**Full documentation:** `docs/QWEN_CONTEXT_WINDOW_FIX.md`

---

## Testing Both Fixes

After restarting the app, test with a task requiring multiple tool calls:

**Test Prompt:**
```
Can you check the weather in San Francisco using curl, 
then create a plan for me to visit the city?
```

**Expected Behavior:**

1. **UI**: One "Working on it..." card showing:
   - Thinking: "I'll check the weather..."
   - Tool Call: `bash` with curl command
   - Tool Result: Weather data
   - Tool Call: `create_plan` with SF visit plan
   - Final Response: Summary with plan

2. **Logs**: No truncation warnings
   ```bash
   tail -f ~/.cursor/projects/.../terminals/*.txt | grep "truncating"
   # Should be empty after fix
   ```

3. **Database**: One assistant message
   ```sql
   SELECT COUNT(*) FROM messages 
   WHERE role = 'assistant' AND chat_id = '...';
   -- Should return 1 (not 2 or 3)
   ```

---

## Files Modified

### Multi-Step Streaming Fix
- ✅ `src/gateway/services/agent/streamOrchestrator.ts`
- ✅ `src/gateway/services/AgentService.ts`
- ✅ `src/core/types/streaming.ts`
- ✅ `docs/MULTI_STEP_STREAMING_FIX.md`

### Context Window Fix
- ✅ `src/gateway/services/AgentService.ts`
- ✅ `docs/QWEN_CONTEXT_WINDOW_FIX.md`

### Documentation
- ✅ `CLAUDE.md` (Issue 12 & 13)
- ✅ This summary document

---

## Prevention Guidelines

### For Future Model Integrations

1. **Always check actual context window** (Hugging Face model card)
2. **Calculate tool schema size**: `~120 tokens per tool × 70 tools = 8.5K`
3. **Set `num_ctx` appropriately**:
   - Minimum: `tool_tokens × 1.5`
   - Recommended: `tool_tokens × 4`
   - Never use Ollama's 4K default!

4. **Test with multi-step scenarios** (3+ tool calls)
5. **Monitor Ollama logs** for truncation warnings
6. **Verify tool availability** by asking model what tools it has

### Context Window Guidelines by Model Size

| Model Size | Native Context | Recommended `num_ctx` |
|-----------|---------------|---------------------|
| 1-3B | 32K | 8,192 (minimal tools) |
| 7-9B | 32-128K | 16,384-32,768 |
| 14-30B | 128K+ | 32,768-65,536 |
| 70B+ | 200K+ | 65,536+ |

---

## Related Documentation

- `docs/MULTI_STEP_STREAMING_FIX.md` - Detailed streaming fix
- `docs/QWEN_CONTEXT_WINDOW_FIX.md` - Detailed context fix
- `CLAUDE.md` - Project context & learnings (Issue 12 & 13)
- `docs/TOOL_RESULT_OBJECT_TRUNCATION_FIX.md` - Previous tool-related fix

---

## Lessons Learned

1. **Multi-step streaming needs careful chunk type design**
   - Reserve `done` for final completion only
   - Use specific types (`step-usage`) for intermediate events

2. **Default settings are often inadequate**
   - Ollama's 4K default is from 2023 (smaller models)
   - Modern models need 8x-32x that for tool-heavy agents

3. **Tool schemas are expensive**
   - 70 tools = 8.5K tokens
   - Consider dynamic tool loading for smaller models

4. **Always read the logs**
   - Truncation warnings are easy to miss
   - They reveal configuration issues early

5. **Test edge cases**
   - Multi-step tool calling reveals streaming bugs
   - Tool-heavy tasks reveal context issues
