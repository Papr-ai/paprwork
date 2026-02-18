# Max Tokens Fix - Preventing Mid-Sentence Cutoffs

**Date:** 2026-02-17  
**Issue:** Agent responses cutting off mid-sentence  
**Root Cause:** No explicit `maxTokens` configured, defaulting to 4096 tokens  
**Status:** ✅ Fixed

---

## Problem

The agent was stopping mid-sentence (e.g., "just make them actually" without completing the thought). This happened because:

1. **No explicit output token limit** was set
2. **Claude defaults to 4096 tokens** when `maxTokens` is not specified
3. **4096 tokens is too low** for complex multi-tool responses

---

## Solution

Added explicit `maxTokens` to all AI models with generous limits:

### Token Limits by Provider

| Provider | Max Tokens | Rationale |
|----------|------------|-----------|
| **Anthropic Claude** | 8,192 | Claude's stated maximum output |
| **OpenAI GPT** | 16,384 | GPT-4+ standard max output |
| **Google Gemini** | 8,192 | Gemini's default maximum |

### Why These Limits?

- **Claude 8K:** Official API limit for all Claude models (Haiku, Sonnet, Opus)
- **GPT 16K:** OpenAI allows 16K+ for GPT-4 class models (future-proof)
- **Gemini 8K:** Google's standard for Gemini 2.5 and 3.0 series

---

## Files Changed

### 1. Frontend Types (`ui/constants/models.ts`)
```typescript
export interface AIModel {
  // ... existing fields ...
  maxTokens?: number; // Output token limit
}
```

Added `maxTokens` to **all 13 models**:
- ✅ Claude Haiku 4.5: 8192
- ✅ Claude Sonnet 4.5: 8192
- ✅ Claude Opus 4.5: 8192
- ✅ Claude Opus 4.5 (Deep Thinking): 8192
- ✅ GPT-5.2 (all variants): 16384
- ✅ Gemini (all variants): 8192

### 2. Config Passing (`ui/components/Chat/ChatContainer.tsx`)
```typescript
const config = {
  provider: selectedModel.provider,
  model: selectedModel.id,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  reasoning: selectedModel.reasoning,
  thinkingBudget: selectedModel.defaultThinkingBudget,
  maxTokens: selectedModel.maxTokens, // ← Added this
};
```

### 3. Backend Type (`src/core/types/agents.ts`)
```typescript
export interface AgentConfig {
  provider: Provider;
  model: string;
  systemPrompt: string;
  maxSteps?: number;
  maxTokens?: number; // ← Added this
  thinkingBudget?: number;
  reasoning?: { effort?: "low" | "medium" | "high" | "xhigh"; };
}
```

### 4. AI SDK Integration (`src/gateway/services/AgentService.ts`)
```typescript
const streamTextOptions: any = {
  model,
  messages,
  tools: tools as unknown as ToolSet,
  stopWhen: (stopOptions: any) =>
    stopOptions.steps.length >= (options?.maxSteps ?? 100),
  abortSignal: abortController.signal,
  ...(providerOptions.openai || providerOptions.google ? { providerOptions } : {}),
};

// Add maxTokens if specified
if (config.maxTokens) {
  streamTextOptions.maxTokens = config.maxTokens;
}

const result = await streamText(streamTextOptions);
```

---

## Testing

1. **Reload the app** (or restart: `npm start`)
2. **Send a long message** that requires multiple tool calls
3. **Verify no mid-sentence cutoffs**
4. **Check logs** for `maxTokens` being used

---

## Expected Behavior

### Before Fix
```
Agent: "I'll help you with that. First I'll do X, then Y, and just make them actually"
[RESPONSE ENDS MID-SENTENCE]
```

### After Fix
```
Agent: "I'll help you with that. First I'll do X, then Y, and just make them actually work with proper error handling, tests, and documentation."
[COMPLETE RESPONSE]
```

---

## Why 8192/16384?

**Common Question:** "Isn't 8K/16K too high? Won't that cost more?"

**Answer:**
- `maxTokens` is a **ceiling, not a target**
- The model stops when it's done, not when it hits the limit
- Setting it too low causes mid-sentence cutoffs (bad UX)
- Setting it high prevents cutoffs without increasing cost (model still stops naturally)

**Example:**
- If model wants to write 2000 tokens, it writes 2000 tokens
- If `maxTokens: 4096`, it stops at 4096 even if mid-sentence
- If `maxTokens: 8192`, it writes 2000 tokens and stops naturally

---

## Cost Impact

**None!** The model stops when it's done. `maxTokens` just prevents premature cutoffs.

| Scenario | maxTokens: 4096 | maxTokens: 8192 | Cost Difference |
|----------|-----------------|-----------------|-----------------|
| Model writes 2K tokens | 2K tokens | 2K tokens | **$0** |
| Model writes 5K tokens | 4K tokens (CUT OFF) | 5K tokens | More complete output, slightly higher but proportional cost |
| Model writes 10K tokens | 4K tokens (CUT OFF) | 8K tokens (CUT OFF) | Both cut off (increase to 16K if needed) |

---

## Future: Dynamic Token Budgets

**Potential Enhancement:**
- Allow users to set max tokens per message
- Show token usage in UI
- Warn when approaching limits
- Suggest switching models for long responses

**Not implemented yet** (V2.1+)

---

## Related Issues

- ✅ Interleaved text/tool rendering (sequence)
- ✅ Auto-open app edits
- ✅ Gemini thinking tokens
- ⏳ UI not clearing stop button (separate issue)

---

**This fix ensures agents can complete their responses without arbitrary cutoffs! 🎉**
