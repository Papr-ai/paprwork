# Web Search System Prompt Fix

**Date:** 2026-05-08  
**Issue:** OpenAI web search tool was enabled but never used by agents  
**Status:** ✅ FIXED

## Problem

The OpenAI native `web_search` tool was successfully enabled in the codebase (visible in logs: `[AgentService] ✅ Enabled OpenAI web search`), but agents were falling back to using `bash` with `curl` commands instead of using the native tool.

### Root Cause

The **system prompt** was explicitly instructing agents to use `curl` for web searches, without mentioning the native web search tool:

```markdown
## Key Capabilities

- **Web search**: Use `curl` for quick lookups, APIs, scraping (fast, no browser)
```

And providing curl examples:
```bash
# Web search
curl -s "https://api.duckduckgo.com/?q=query&format=json"
```

The agent was simply following instructions! Even though the `web_search` tool was available, the system prompt never told the model about it or how to use it.

## Solution

Made the system prompt **provider-aware** to conditionally include native web search documentation:

### 1. Added Provider to System Prompt Options

```typescript
export interface SystemPromptOptions {
  // ... existing options
  /** AI provider being used (to enable native web search documentation) */
  provider?: string;
}
```

### 2. Created Native Web Search Documentation Section

Added `buildNativeWebSearchSection()` that shows provider-specific documentation:

**For OpenAI:**
```markdown
# Web Search Tool (OpenAI)

You have access to a native **web_search** tool that enables real-time internet access with citations.

## When to Use
- Current events, news, or recent developments
- Real-time data (weather, stock prices, sports scores)
- Latest documentation, API changes, or library versions

**Note:** Prefer native web search over curl/bash for general web queries.
```

**For Google/Gemini:**
```markdown
# Web Search Tool (Google)

You have access to a native **google_search** tool...
```

**For Anthropic:**
- No web search documentation (uses browser tools or curl as needed)

### 3. Updated Bash Tool Section

Modified `buildBashToolSection()` to:
- **Remove** curl web search examples when native search is available
- **Add** note to prefer native web_search tool over curl
- **Keep** curl examples for providers without native search (Anthropic, Ollama)

### 4. Passed Provider Through Call Chain

Updated the flow to pass provider information:

```typescript
// AgentService.streamAgent()
const systemPrompt = await this.buildContextualSystemPrompt(
  chatId,
  history,
  enabledSkills,
  config.provider, // ← Pass provider
);

// buildContextualSystemPrompt()
return buildSystemPrompt({
  // ... other options
  provider, // ← Pass to builder
});
```

## Provider Support Matrix

| Provider | Native Search Tool | System Prompt Behavior |
|----------|-------------------|------------------------|
| OpenAI   | ✅ `web_search`   | Shows native web search docs, hides curl examples |
| Google   | ✅ `google_search` | Shows native web search docs, hides curl examples |
| Anthropic | ❌ (disabled)    | No web search docs, shows curl examples |
| Ollama   | ❌ (local)       | No web search docs, shows curl examples |

## Testing

### Manual Test
1. Start the app: `npm start`
2. Select an OpenAI/GPT model
3. Ask: "What's the latest news about AI?"
4. Verify: Agent should use `web_search` tool instead of `bash` with `curl`

### Automated Test
```bash
node scripts/test-web-search-prompt.mjs
```

This verifies:
- OpenAI prompts include web search documentation
- Google prompts include web search documentation
- Anthropic prompts do NOT include web search documentation
- Curl examples are conditionally included/excluded

## Files Modified

1. `src/core/agents/SystemPrompt.ts`
   - Added `provider` to `SystemPromptOptions`
   - Added `buildNativeWebSearchSection()` method
   - Updated `buildBashToolSection()` to be provider-aware
   - Updated `getShellExamples()` to conditionally exclude curl web search

2. `src/gateway/services/AgentService.ts`
   - Updated `buildContextualSystemPrompt()` to accept provider parameter
   - Passed provider from `streamAgent()` to system prompt builder

3. `scripts/test-web-search-prompt.mjs` (new)
   - Test script to verify system prompt correctness

4. `docs/WEB_SEARCH_SYSTEM_PROMPT_FIX.md` (this file)
   - Documentation of the fix

## Expected Behavior After Fix

### Before Fix
```
User: "What's the latest news about AI?"
Agent: [Plans to use bash/curl] "I'll re-check with live search..."
→ bash({ command: 'curl -s "https://api.duckduckgo.com/..."' })
```

### After Fix
```
User: "What's the latest news about AI?"
Agent: [Uses native web_search tool]
→ web_search (executed by OpenAI)
→ Returns results with citations
```

## Backward Compatibility

✅ **Fully backward compatible**
- Providers without native search continue to work as before
- System prompt generation without provider still works (no web search docs)
- No breaking changes to existing APIs

## Future Improvements

1. **Anthropic Web Search**: Once Anthropic's `web_search_20260209` is stable and tested, update `buildNativeWebSearchSection()` to include Anthropic documentation

2. **Dynamic Tool Discovery**: Instead of hardcoding provider checks, could introspect available tools and show documentation dynamically

3. **Tool Usage Analytics**: Track which providers/tools are being used to optimize system prompts further
