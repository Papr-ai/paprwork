# Provider Switching Tool Format Fix

**Added:** 2026-04-30  
**Status:** ✅ Resolved

## Problem

Users experienced validation errors when switching from Claude (via pi-ai OAuth) to Gemini (via AI SDK) in the same conversation:

```
⚠️ The AI model returned an invalid tool call. This is usually temporary.

What you can do:
• Try sending your message again
• Try a different model (e.g., GPT-5.5 → Claude Sonnet)
• If this persists, please report this issue
```

**Symptoms:**
- ✅ Conversation with Claude (pi-ai) works fine with tool calls
- ✅ New conversation with Gemini works fine with tool calls
- ❌ Switching from Claude to Gemini mid-conversation fails with validation error
- ❌ Tool calls from Claude session history rejected by Gemini

**Example scenario:**
1. User starts chat with Claude (OAuth) - makes several tool calls
2. User switches to Gemini (API key) in the same chat
3. Gemini receives history with Claude's tool calls
4. Gemini rejects tool calls due to format mismatch

## Root Cause

**Different providers have different tool name requirements:**

1. **Claude (via pi-ai):** More permissive, allows dots in tool names
   - Example: `google.search`, `file.read`

2. **Gemini (via AI SDK):** Strict validation, requires `^[a-zA-Z0-9_-]+$`
   - ✅ Allowed: letters, numbers, underscores (`_`), hyphens (`-`)
   - ❌ NOT allowed: dots (`.`), spaces, or special characters

**The existing sanitization only covered tool IDs, not tool names:**

```typescript
// historyFormatter.ts (BEFORE FIX)
const toolCallId = rawId.replace(/[^a-zA-Z0-9_-]/g, "_"); // ✅ ID sanitized
const toolName = typeof tc.name === "string" ? tc.name : "unknown"; // ❌ Name NOT sanitized
```

When switching providers, tool names from history were passed as-is to the new provider. If a Claude tool call had a name like `google.search`, Gemini would reject it.

## The Fix

**File:** `src/gateway/services/agent/historyFormatter.ts`

Sanitize tool names (not just IDs) when loading from history:

```typescript
// BEFORE (line 246-252)
for (const tc of toolCalls) {
  const rawId = typeof tc.id === "string" ? tc.id : `tc-hist-${toolIndex}`;
  const toolCallId = rawId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const toolName = typeof tc.name === "string" ? tc.name : "unknown"; // ❌
  
  contentParts.push({
    type: "tool-call",
    toolCallId,
    toolName, // ❌ Unsanitized
    args: tc.args ?? {},
  });
}

// AFTER (with fix)
for (const tc of toolCalls) {
  const rawId = typeof tc.id === "string" ? tc.id : `tc-hist-${toolIndex}`;
  const toolCallId = rawId.replace(/[^a-zA-Z0-9_-]/g, "_");
  
  // Sanitize tool names for Gemini compatibility ✅
  const rawToolName = typeof tc.name === "string" ? tc.name : "unknown";
  const toolName = rawToolName.replace(/[^a-zA-Z0-9_-]/g, "_"); // ✅
  
  contentParts.push({
    type: "tool-call",
    toolCallId,
    toolName, // ✅ Sanitized
    args: tc.args ?? {},
  });
}
```

**What changed:**
- Tool names from history are now sanitized using the same pattern as tool IDs
- Dots, spaces, and special characters are replaced with underscores
- `google.search` → `google_search`
- `file.read` → `file_read`

## Impact

**Before:**
- ❌ Switching from Claude to Gemini mid-conversation failed
- ❌ Tool calls from Claude history rejected by Gemini
- ❌ User had to start a new chat to use Gemini

**After:**
- ✅ Can switch between any providers mid-conversation
- ✅ Tool calls from history properly sanitized for new provider
- ✅ Seamless provider switching experience

## Why This Matters

**Multi-provider conversations are common:**
1. User starts with Claude Pro (OAuth) - cheaper for exploration
2. Switches to Gemini - better for specific tasks
3. Switches to GPT-5.5 - for final polish

Without this fix, switching providers would break tool call history and force users to start fresh conversations.

## Testing

To verify the fix:
```bash
1. Start chat with Claude (OAuth)
2. Send message requiring tool calls: "Read the README file"
3. Observe tool calls working correctly
4. Switch to Gemini model (gemini-2.5-flash)
5. Send another message: "What did the README say?"
6. Verify Gemini can access tool call history without errors
7. Switch to GPT-5.5 and verify again
```

## Prevention

**Rules for tool name handling:**

1. **Always sanitize tool names in history:** Use `^[a-zA-Z0-9_-]+$` pattern
2. **Document provider requirements:** Track which providers are strictest
3. **Test provider switching:** Add tests for Claude→Gemini, GPT→Claude, etc.
4. **Use snake_case for tool names:** Avoid dots in tool definitions

**When adding new providers:**
- Check tool name validation requirements in provider docs
- Test with existing conversation history from other providers
- Ensure sanitization handles all edge cases

## Related Issues

- **Native Tool ID Fix:** [GEMINI_TOOL_VALIDATION_ISSUE.md](./GEMINI_TOOL_VALIDATION_ISSUE.md)
  - Fixed dots in native tool IDs (`google.google_search` → `google_search`)
  - This fix extends sanitization to tool names in history

## Related Files

- `src/gateway/services/agent/historyFormatter.ts` - Tool name sanitization
- `src/gateway/services/providers/piAiHelpers.ts` - Pi-ai context builder
- `src/gateway/services/AgentService.ts` - Provider routing logic
- `ui/hooks/useAgent.ts` - Error message display

## References

- **Gemini Function Calling:** https://ai.google.dev/gemini-api/docs/function-calling
- **AI SDK Tool Calling:** https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling
- **Pattern validation:** `^[a-zA-Z0-9_-]+$` (alphanumeric + underscore + hyphen only)
- **Claude Tool Use:** https://docs.anthropic.com/en/docs/build-with-claude/tool-use
