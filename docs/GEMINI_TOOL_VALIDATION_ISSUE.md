# Gemini Tool Validation Issue ✅ FIXED

**Added:** 2026-04-22  
**Fixed:** 2026-04-22  
**Status:** ✅ Resolved

## Problem

Users experienced validation errors when using Gemini models with tool calls:

```
Invalid 'input[3].name': string does not match pattern. 
Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.
```

**Symptoms:**
- ✅ Text-only chat with Gemini worked fine
- ✅ Tool calls with OpenAI/Claude worked fine  
- ❌ Tool calls with Gemini failed with validation error
- ❌ Error **persisted to GPT-5.4** after using Gemini (tool state pollution)

## Root Cause ✅ FOUND

The **native Google Search tool** from `@ai-sdk/google` had a tool ID with a **dot**:

```javascript
import { google } from '@ai-sdk/google';
const tool = google.tools.googleSearch({});

console.log(tool.id); 
// Output: "google.google_search" ❌ Contains a dot!
```

**Gemini's strict requirement:** Tool names must match `^[a-zA-Z0-9_-]+$`
- ✅ Allowed: letters, numbers, underscores (`_`), hyphens (`-`)  
- ❌ **NOT** allowed: dots (`.`), spaces, or other special characters

When we merged native search tools with custom tools, the tool object with `id: "google.google_search"` was passed to Gemini's API, which rejected it.

## Why It Affected Other Models

The error **persisted to GPT-5.4** because:

1. Tools are registered once in `toolRegistry` at startup
2. Native search tools are **merged** into the tools object at request time
3. Once the corrupted tool object existed in memory, it contaminated subsequent requests
4. Even switching to GPT-5.4, the same tool object (with dot in ID) was reused

## The Fix ✅

**File:** `src/gateway/services/AgentService.ts`

Override the tool ID when adding native search tools to remove dots:

```typescript
case "google":
  const googleSearchTool = google.tools.googleSearch({});
  // ⚠️ CRITICAL: Override tool ID to remove dot
  tools.google_search = {
    ...googleSearchTool,
    id: "google_search", // ✅ No dot
  };
  break;

case "openai":
  const webSearchTool = openai.tools.webSearch({...});
  // Sanitize ID: replace dots with underscores
  const toolId = webSearchTool.id.replace(/\./g, '_');
  tools.web_search = {
    ...webSearchTool,
    id: toolId,
  };
  break;
```

**What changed:**
- Original ID: `"google.google_search"` → Fixed ID: `"google_search"`
- All dots in tool IDs are now replaced with underscores
- Works across all providers (Gemini, GPT, Claude)

## Impact

**Before:**
- ❌ Gemini failed on every tool call attempt
- ❌ Error persisted to other models after using Gemini
- ❌ Massive validation error dumps in UI

**After:**  
- ✅ Gemini tool calls work correctly
- ✅ No state pollution between models
- ✅ User-friendly error messages (from separate UX fix)

## Better Error UX (Also Implemented)

**File:** `ui/hooks/useAgent.ts`

Even with the fix, if validation errors occur, users now see:

```
⚠️ The AI model returned an invalid tool call. This is usually temporary.

What you can do:
• Try sending your message again
• Try a different model (e.g., Gemini → Claude Sonnet)
• If this persists, please report this issue
```

Instead of massive Zod validation dumps. Technical details still logged to console for debugging.

## Testing

To verify the fix:
```bash
1. Select Gemini model (gemini-2.5-flash)
2. Send message requiring tool calls: "Search the web for latest AI news"
3. Observe Google Search tool being called successfully
4. Switch to GPT-5.4 and verify tool calls still work (no pollution)
```

## Prevention

**Rule for future native tool integrations:**

Always sanitize tool IDs when integrating provider-native tools:

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

**Why this matters:**
- Different providers have different naming conventions
- Gemini is strictest: `^[a-zA-Z0-9_-]+$` only
- OpenAI/Claude more permissive but consistency is better
- Always normalize to `snake_case` with underscores

## Related Files

- `src/gateway/services/AgentService.ts` - Tool ID sanitization
- `ui/hooks/useAgent.ts` - Better error UX
- `docs/GEMINI_TOOL_VALIDATION_ISSUE.md` - This file

## References

- **Gemini Function Calling:** https://ai.google.dev/gemini-api/docs/function-calling
- **AI SDK Provider Tools:** https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling
- **Pattern validation:** `^[a-zA-Z0-9_-]+$` (alphanumeric + underscore + hyphen only)
