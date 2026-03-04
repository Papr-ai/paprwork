# Qwen Context Window Fix - Tool Schema Truncation

**Date:** 2026-03-04  
**Issue:** Qwen 3.5 9B only seeing subset of tools (delegation/planning tools) and claiming it doesn't have access to core tools (bash, filesystem, browser, etc.)

## Problem

When using Qwen 3.5 with Ollama, the model was only seeing ~15 tools out of 70 total tools, specifically:
- ✅ Seeing: Delegation tools, planning tools, API key management
- ❌ Missing: `bash`, `web_browser`, `filesystem`, and most other core tools

### Root Cause

**Ollama's default `num_ctx` parameter is 4096 tokens**, which is FAR too small for Paprwork's tool-heavy agent:

```
Tools: 70 tools, ~8549 tokens  ← Tool schemas alone
```

**Evidence from Ollama logs:**
```
[Ollama] level=WARN msg="truncating input prompt" limit=4096 prompt=11483 keep=4 new=4096
```

The full prompt was **11,483 tokens** (8.5K tools + conversation + system prompt), but Ollama was **truncating to 4,096 tokens**, cutting off most of the tool schemas. The model only saw the first ~15 tools before truncation.

### Why This Matters

For Qwen 3.5 9B specifically:
- **Actual context window**: 128K tokens (per Hugging Face model card)
- **Ollama default**: 4,096 tokens (only 3% of capacity!)
- **Required for 70 tools**: ~12K tokens minimum (tools + conversation)
- **Recommended setting**: 32,768 tokens (provides headroom for long conversations)

## Solution

Set `num_ctx: 32768` in Ollama provider options:

```typescript
// src/gateway/services/AgentService.ts
if (config.provider === "ollama") {
  providerOptions.ollama = {
    think: true, // Enable thinking mode for tool calling
    options: {
      num_ctx: 32768, // Set context window to 32K
      // Default is 4096 which is too small for 70 tools (~8.5K tokens)
    },
  };
}
```

### Why 32K?

- **Tool schemas**: ~8.5K tokens
- **System prompt**: ~2K tokens
- **Conversation history**: ~5-10K tokens (average)
- **Thinking + responses**: ~5-10K tokens per turn
- **Safety margin**: 2x buffer for long tool-heavy conversations

**32K provides comfortable headroom without exhausting Qwen's 128K limit.**

### Changes Made

1. **`src/gateway/services/AgentService.ts`**:
   - Added `options: { num_ctx: 32768 }` to `providerOptions.ollama`
   - Updated TypeScript type definition to include `options` field

2. **Type definition updated**:
   ```typescript
   ollama?: {
     think: boolean;
     options?: {
       num_ctx?: number; // Context window size
       seed?: number;
       repeat_penalty?: number;
       top_k?: number;
       min_p?: number;
     };
   };
   ```

## Testing

After the fix, Qwen should:

1. **See all 70 tools** without truncation
2. **No more Ollama WARN logs** about "truncating input prompt"
3. **Successfully use core tools** like `bash`, `web_browser`, `filesystem`

**Verification commands:**

```bash
# Start app and send message requiring bash tool
# Check terminal logs for:
tail -f ~/.cursor/projects/.../terminals/*.txt | grep "truncating"
# Should NOT see any truncation warnings

# Or check if all tools are being used:
tail -f ~/.cursor/projects/.../terminals/*.txt | grep "Tool calls:"
# Should see variety of tools, not just delegation/planning
```

## Prevention

### For Future Model Integrations

When adding new local models via Ollama:

1. **Check model's actual context window** (Hugging Face model card)
2. **Calculate tool schema size**: 70 tools ≈ 8.5K tokens
3. **Set `num_ctx` appropriately**:
   - **Minimum**: `tool_tokens * 1.5` (12K for 70 tools)
   - **Recommended**: `tool_tokens * 4` (32K for 70 tools)
   - **Never use default 4096** for tool-heavy agents!

### Context Window Guidelines by Model Size

| Model Size | Context Window | Recommended `num_ctx` |
|-----------|----------------|---------------------|
| 1-3B | 32K | 8,192 (minimal tools) |
| 7-9B | 32-128K | 16,384-32,768 |
| 14-30B | 128K+ | 32,768-65,536 |
| 70B+ | 200K+ | 65,536+ |

**Rule of thumb:** Set `num_ctx` to at least 4x your tool schema size.

## Related Issues

This issue would affect ANY Ollama model with default settings when using Paprwork's full tool suite. Models particularly affected:
- **Small models (1-3B)**: May struggle with 70 tools even with increased context
- **Mid-size models (7-14B)**: Should work well with 32K context
- **Large models (30B+)**: Can handle full tool suite with 32K+

### Recommendation: Tool Filtering

For smaller models (<7B), consider:
1. **Tool filtering** based on task type
2. **Dynamic tool loading** (only load relevant tools per conversation)
3. **Tool grouping** (load core tools + task-specific tools)

Example:
```typescript
// Only load bash + filesystem tools for code tasks
const tools = this.toolRegistry.getToolsForMastra(
  ['bash', 'filesystem', 'web_browser'] // Specific tool IDs
);
```

This would reduce tool schema from 8.5K tokens to ~1-2K tokens, making it feasible for smaller models.

## Lessons Learned

1. **Always check Ollama logs** - The truncation warning is easy to miss
2. **Tool schema size matters** - 70 tools at ~120 tokens each = 8.5K tokens
3. **Default settings are often wrong** - Ollama's 4K default is from 2023 when models were smaller
4. **Context != Model capacity** - Just because a model CAN handle 128K doesn't mean Ollama WILL use it
5. **Test with tool-heavy tasks** - Edge cases reveal configuration issues

## References

- [Ollama API Documentation](https://github.com/ollama/ollama/blob/main/docs/api.md#parameters)
- [Qwen 3.5 9B Model Card](https://huggingface.co/Qwen/Qwen3.5-9B)
- [ollama-ai-provider-v2 README](https://github.com/sgomez/ollama-ai-provider/blob/main/README.md)
