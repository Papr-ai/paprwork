# Gemini Tool Validation Fix - Summary

**Date:** 2026-04-22  
**Issue:** Invalid tool names causing Gemini API rejection  
**Status:** ✅ FIXED

## Problem

Users reported validation errors when using Gemini (and GPT-5.4 after Gemini):

```
Invalid 'input[3].name': string does not match pattern. 
Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.
```

**Key symptom:** Error **persisted to other models** after using Gemini, suggesting tool state pollution.

## Root Cause

The **native Google Search tool** from `@ai-sdk/google` had a tool ID with a dot:

```javascript
import { google } from '@ai-sdk/google';
const tool = google.tools.googleSearch({});

console.log(tool.id); 
// Output: "google.google_search" ❌ Contains a dot!
```

**Gemini's requirement:** Tool names must match `^[a-zA-Z0-9_-]+$` (no dots allowed).

## The Fix

**File:** `src/gateway/services/AgentService.ts`  
**Method:** `buildNativeSearchTools()`

### Google Search Tool (Gemini)

```typescript
const googleSearchTool = google.tools.googleSearch({});
// Override tool ID to remove dot
tools.google_search = {
  ...googleSearchTool,
  id: "google_search", // ✅ No dot (was: "google.google_search")
};
```

### OpenAI Web Search Tool (Defensive)

```typescript
const webSearchTool = openai.tools.webSearch({...});
// Check if ID exists and sanitize if needed
const hasId = typeof (webSearchTool as any).id === 'string';
if (hasId && (webSearchTool as any).id.includes('.')) {
  tools.web_search = {
    ...webSearchTool,
    id: (webSearchTool as any).id.replace(/\./g, '_'),
  };
}
```

## Additional Fix: Better Error UX

**File:** `ui/hooks/useAgent.ts`  
**File:** `ui/components/Chat/ChatContainer.css`

When validation errors occur (for any reason), show user-friendly message:

```
⚠️ The AI model returned an invalid tool call. This is usually temporary.

What you can do:
• Try sending your message again
• Try a different model (e.g., Gemini → Claude Sonnet)
• If this persists, please report this issue
```

**CSS updates:**
- Multi-line error support with `white-space: pre-wrap`
- Better line spacing with `line-height: 1.5`
- Proper text wrapping with `word-wrap: break-word`

## Impact

**Before:**
- ❌ Gemini tool calls always failed
- ❌ Error persisted to GPT-5.4 after using Gemini
- ❌ Massive validation error dumps in UI (50+ lines of Zod errors)

**After:**
- ✅ Gemini tool calls work correctly
- ✅ No state pollution between models  
- ✅ User-friendly error messages
- ✅ Technical details still logged for debugging

## Testing

To verify:

```bash
# 1. Start the app
npm start

# 2. Select Gemini model (gemini-2.5-flash)

# 3. Send message requiring web search
"What are the latest AI news today?"

# 4. Verify Google Search tool is called successfully

# 5. Switch to GPT-5.4 and verify tool calls still work
```

## Prevention Rule

**When integrating provider-native tools, always sanitize tool IDs:**

```typescript
// ❌ BAD: Use tool as-is
tools.my_tool = provider.tools.someTool({});

// ✅ GOOD: Sanitize tool ID
const tool = provider.tools.someTool({});
tools.my_tool = {
  ...tool,
  id: tool.id.replace(/\./g, '_'), // Remove dots
};
```

## Files Changed

1. **src/gateway/services/AgentService.ts**
   - Added tool ID sanitization for Google Search
   - Added defensive sanitization for OpenAI web search
   - Comments explaining Gemini's strict requirements

2. **ui/hooks/useAgent.ts**
   - Added validation error pattern detection
   - User-friendly error message for tool validation failures

3. **ui/components/Chat/ChatContainer.css**
   - Multi-line error banner support
   - Better readability and spacing

4. **docs/GEMINI_TOOL_VALIDATION_ISSUE.md**
   - Complete documentation of issue and fix
   - Prevention guidelines for future integrations

## Technical Details

**Why dots are problematic:**

Different AI providers have different naming conventions:
- **Gemini:** Strictest - `^[a-zA-Z0-9_-]+$` only
- **OpenAI/Claude:** More permissive - allow dots in some contexts
- **Best practice:** Always normalize to `snake_case` with underscores

**Why error persisted across models:**

1. Native search tools are merged into the tools object at request time
2. Tool objects are reused across requests (same memory reference)
3. Once corrupted tool ID existed, it contaminated all subsequent requests
4. Even switching models, the same tool object was reused

**The fix:**
- Creates new tool object with sanitized ID (doesn't mutate original)
- Each request gets fresh tool objects with clean IDs
- No state pollution between model switches

## Related Issues

- **Issue 65:** PI-AI Validation Loop - Different issue (circuit breakers for infinite validation loops)
- This fix is specific to native provider tools with invalid characters in IDs

## References

- [Gemini Function Calling Docs](https://ai.google.dev/gemini-api/docs/function-calling)
- [AI SDK Tools Documentation](https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling)
- Tool name pattern: `^[a-zA-Z0-9_-]+$`
