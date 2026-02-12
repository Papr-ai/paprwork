# Context Length Exceeded Analysis

**Error**: `context_length_exceeded` on step 2 (after first tool call)

---

## Current Situation

### Model Being Used
- **Default**: Claude Sonnet 4.5 (`claude-sonnet-4-5`)
- **Context Window**: 200,000 tokens (200K)
- **Extended Context**: 1M tokens available with beta header

### What's Happening
```
Step 1: User message + thinking + tool call → ✅ SUCCESS
Step 2: Try to continue with tool result → ❌ context_length_exceeded
```

The agent stops after 1 tool call, not because of the `stopWhen` limit, but because **the context is already too large**.

---

## Token Breakdown (Estimated)

Let's calculate what's being sent on step 2:

### System Prompt
The `SystemPromptBuilder` includes:
- Identity section
- Tool documentation (bash tool with examples)
- API key management guide
- Security guidelines
- Examples and best practices

**Estimated**: ~5,000-10,000 tokens

### Conversation History
- User message: ~50-100 tokens
- Assistant thinking: Can be 5,000-32,000 tokens (depending on model)
- Tool call args: ~200 tokens
- Tool result: **???** (Could be massive!)

### The Problem: Tool Results

If the tool result is the full output of `ls -laR ~/Dropbox`, it could be **100,000+ tokens**!

Example:
```bash
ls -laR ~/Dropbox
# Could output thousands of files
# Each file = ~200 characters
# 5000 files = 1,000,000 characters = ~250,000 tokens
```

---

## Solution: Result Truncation (Already Implemented!)

We already have `truncateResult()` in `src/core/tools/security.ts`:

```typescript
export function truncateResult(result: string, maxLength: number = 50000): string
```

**Current limit**: 50,000 characters ≈ **12,500 tokens**

### But Wait - Where's the Issue?

Let me check if truncation is being applied to tool results BEFORE they go to the LLM...

**Check needed**: In `AgentService.ts`, when we stream tool-result chunks, we truncate for the UI, but do we truncate for the **LLM's context**?

---

## Comparison: V1 vs OpenClaw

### Paprwork V1
- **Model**: Claude Sonnet 4.5 (same as V2)
- **Context Mgmt**: Manual compaction after ~10 messages
- **Tool Results**: Likely includes full results (no truncation)
- **Prompt Length**: Shorter system prompt (~2000 tokens)

### OpenClaw
- **Model**: Configurable (supports all providers)
- **Context Mgmt**: Automatic compaction
- **Tool Results**: Unknown (need to check)
- **Prompt Length**: Comprehensive system prompt

---

## Root Cause Hypothesis

### Theory 1: Tool Results Not Truncated for LLM
The `tool-result` chunk we send to the UI is truncated, but the actual result stored in the LLM's context (via AI SDK) might be the FULL untruncated result.

**Check**: Does AI SDK's `streamText` automatically use the truncated result, or does it use the original tool execution output?

### Theory 2: Thinking Tokens Are Huge
With extended thinking mode:
- Claude Opus 4.5: 32,000 token thinking budget
- GPT-5.2 xhigh: Similar large thinking budgets

**Impact**: First message uses 32K for thinking, leaving only 168K for everything else.

### Theory 3: System Prompt Too Long
Our system prompt might be significantly longer than V1's.

**Check needed**: Count tokens in built system prompt.

---

## Recommended Fixes

### Fix 1: Aggressive Tool Result Truncation for LLM
```typescript
// In tool execution, truncate BEFORE returning to AI SDK
const MAX_TOOL_RESULT_FOR_LLM = 10000; // characters (~2500 tokens)

// Truncate in the tool's execute function itself
if (typeof result === 'string' && result.length > MAX_TOOL_RESULT_FOR_LLM) {
  result = result.substring(0, MAX_TOOL_RESULT_FOR_LLM) + 
    `\n\n[... ${result.length - MAX_TOOL_RESULT_FOR_LLM} characters truncated]`;
}
```

### Fix 2: Lower Thinking Budgets
```typescript
// Use more reasonable defaults
defaultThinkingBudget: 5000  // Instead of 32000 for extended thinking
```

### Fix 3: Shorter System Prompt
Break system prompt into:
- **Core** (~2K tokens): Always included
- **Tool Docs** (~5K tokens): Only include when tools are available
- **Examples** (~3K tokens): Optional, exclude by default

### Fix 4: Switch to Extended Context Mode
For Claude Sonnet 4.5, enable 1M context:
```typescript
providerOptions.anthropic = {
  headers: {
    'anthropic-beta': 'context-1m-2025-08-07'
  }
};
```

---

## Quick Win: Increase Context Limit Check

Our compaction triggers at 100K tokens:
```typescript
maxTokens: 100000  // Current
```

But Claude Sonnet 4.5 supports 200K! We should:
```typescript
maxTokens: 180000  // Use 90% of available context
```

---

## Investigation Steps

1. **Log actual context size** on each step:
   ```typescript
   console.log(`[AgentService] Step ${stepNumber}: ~${estimateTokens(messages)} tokens`);
   ```

2. **Log tool result sizes**:
   ```typescript
   console.log(`[Tool ${toolName}] Result size: ${result.length} chars`);
   ```

3. **Log system prompt size**:
   ```typescript
   const promptTokens = Math.ceil(systemPrompt.length / 4);
   console.log(`[AgentService] System prompt: ~${promptTokens} tokens`);
   ```

4. **Check what V1 does**:
   ```bash
   grep -r "truncate\|context.*exceed" /path/to/paprwork-v1
   ```

---

## Next Steps

1. **Immediate**: Check terminal logs - what was the ls command that caused this?
2. **Quick fix**: Add result size logging to see what's causing the overflow
3. **Proper fix**: Ensure tool results are truncated before going to LLM context
4. **Long-term**: Implement smarter context management (summarize old tool results)

---

## Expected Behavior

After fix, should handle:
- Multiple tool calls (5-10+)
- Large tool outputs (truncated smartly)
- Long conversations (with automatic compaction)
- Extended thinking (with reasonable budgets)

---

## Files to Check

1. `src/core/tools/bash.ts` - Where tool results come from
2. `src/gateway/services/AgentService.ts` - Where results go to LLM
3. `src/gateway/services/storage/LocalStorageProvider.ts` - Context compression
4. `src/core/agents/SystemPrompt.ts` - System prompt length
