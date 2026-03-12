# Context Inspector Display Improvements

**Date:** 2026-03-08 (Additional fixes after initial release)

## Understanding AI SDK Message Flow

The AI SDK uses a specific message flow for tool calls:

```
1. User: "Please update the app"
2. Assistant: [text] + [tool-call, tool-call, ...]  ← Planning what to do
3. Tool: [tool-result, tool-result, ...]            ← Results from executing tools
4. Assistant: "Updated. What I changed..."          ← Final response using results
```

This is sent to the LLM as:
```typescript
[
  { role: "user", content: "Please update the app" },
  { role: "assistant", content: [
      { type: "text", text: "I'll update..." },
      { type: "tool-call", toolName: "edit_file", ... },
      { type: "tool-call", toolName: "bash", ... }
  ]},
  { role: "tool", content: [
      { type: "tool-result", toolName: "edit_file", result: "..." },
      { type: "tool-result", toolName: "bash", result: "..." }
  ]},
  { role: "assistant", content: "Updated. What I changed..." }
]
```

The context inspector must display this correctly to match what the LLM sees.

---

## Issues Fixed

### Issue 1: Tool Results Attached to Wrong Message ✅ **CRITICAL**

**Problem:** Tool results were being appended to the FINAL assistant response instead of the assistant message that called the tools.

**What user saw:**
```
ASSISTANT: "Updated. What I changed for the Individual operator-builders segment..."
→ Tool results: create_plan: {...}; edit_app_file: {...}; bash: {...}; ...
```

This was confusing because:
- The tool calls happened BEFORE this message
- This message is the result of USING those tool results
- It looked like tools ran after the response finished

**Root Cause:** The code was merging tool messages with the PREVIOUS entry in the breakdown array, which could be:
- The assistant message that called the tools (correct) ✓
- OR a later assistant message (wrong) ✗

**Fix:** Look AHEAD from the assistant message with tool-calls to find the next tool message:

```typescript
// When we find assistant with tool-calls
if (toolCallParts.length > 0) {
  // Look ahead for tool results (should be next message)
  if (i + 1 < messages.length && messages[i + 1].role === "tool") {
    // Merge tool results with THIS assistant message
  }
}
```

Now tool results are correctly attached to the assistant message that called them, not to later messages.

---

### Issue 2: System Prompt and Summary in Message History ✅

**Problem:** The message history section showed:
- System prompt (should be in separate "System Prompt" section)
- Conversation summary (should be in separate "Conversation Summary" section)

This made the "Message History" section cluttered and showed data twice.

**Fix:** Skip system and summary messages when building message breakdown:
- System messages (`role: "system"`) - excluded
- Summary user messages (start with `[CONVERSATION CONTEXT -`) - excluded

Now "Message History" only shows actual conversation messages (user/assistant exchanges).

---

### Issue 3: Tool Results Too Truncated (Not Useful) ✅

**Problem:** Tool results were truncated to only 50 characters, making them useless for debugging or understanding what happened.

**Example of what user saw:**
```
→ Tool results: edit_app_file: {"success":true,"data":{"filename":"main.ts","upda...
```

Only seeing `"upda...` doesn't tell you:
- Did the tool succeed or fail?
- What was actually changed?
- Were there any errors?

**Why 50 chars was too short:**
- Can't verify tool behavior
- Can't debug issues
- Can't confirm LLM received correct context

**The Fix:** Show **500 characters per tool result** (matches LLM historical truncation):

```typescript
const PREVIEW_LENGTH = 500; // ~125 tokens, matches history truncation
const truncated = resultStr.substring(0, PREVIEW_LENGTH);
const suffix = resultStr.length > PREVIEW_LENGTH 
  ? `... [+${resultStr.length - PREVIEW_LENGTH} chars]` 
  : "";
```

**Now shows:**
```
→ Tool results:
edit_app_file: {"success":true,"data":{"filename":"main.ts","updated":true,"changes":[{"line":145,"old":"whyDistinguishing: 'Targeting operators helps them find...'","new":"whyDistinguishing: 'Why target operators? They're the ones who need..."}],"linesChanged":1}} ... [+234 chars]
bash: {"success":true,"data":{"stdout":"28: exampleIndividualOperators: [\n      {\n        title: 'Founder or CEO',\n        company: 'seed-Series A B2B SaaS startup',\n        why: 'doing founder-led sales/research'\n      }"}}
```

**Benefits:**
- Can see success/failure status
- Can see key data (filename, changes, output)
- Matches LLM context truncation (500 chars for historical messages)
- Shows truncation indicator so you know there's more
- Each result on separate line for readability

**Comparison to LLM context:**
- **Historical messages:** 400 chars (100 tokens) - we show 500 ✓
- **Recent messages (low pressure):** 1,500-12,000 chars - we show preview
- **Recent messages (high pressure):** 500-4,000 chars - we match lower end

This gives an accurate representation of what the LLM sees for most cases.

---

**Problem:** Tool result messages showed huge token counts (9,228 tokens in screenshot). This happened because we were doing `JSON.stringify(msg.content)` on the entire structured content array, which includes full tool results.

**Why this was wrong:** 
- Tool results in actual LLM context are truncated (100-400 chars per the adaptive truncation logic)
- But context inspector was showing the RAW untruncated JSON structure
- This gave misleading token counts

**Fix:** Extract human-readable summaries from structured content:
- For assistant: Show text + tool names
- For tool results: Show truncated previews (50 chars per result)
- Token estimates now match what actually goes to the LLM

**Before:** `[{"type":"tool-result","toolCallId":"call_...","result":"... 5000 chars ..."}]` = 9,228 tokens

**After:** `→ Tool results: search_linkedin: John Doe, Founder at...` = ~100 tokens

---

## Impact

1. **Clearer display** - Tool calls shown inline with assistant messages
2. **No duplication** - System/summary not repeated in message history
3. **Accurate token counts** - Matches actual LLM context, not raw JSON
4. **Better UX** - Users can quickly scan conversation flow

---

## Technical Details

### Message Processing Logic

```typescript
for (const msg of messages) {
  // Skip system prompt (separate section)
  if (msg.role === "system") continue;

  // Skip summary user message (separate section)  
  if (msg.role === "user" && msg.content.startsWith("[CONVERSATION CONTEXT")) {
    continue;
  }

  // Merge tool results with previous assistant message
  if (msg.role === "tool") {
    // Extract tool names and truncated results
    // Append to previous assistant message
    // Don't add as separate entry
    continue;
  }

  // Process user/assistant messages
  // Extract text + tool names for display
  messageBreakdown.push({ role, tokens, preview });
}
```

### Structured Content Parsing

For `role: "assistant"` with array content:
```typescript
{
  type: "text",
  text: "I'll search for people..."
}
{
  type: "tool-call",
  toolName: "search_linkedin",
  args: {...}
}
```

Display as: `"I'll search for people...\n→ Called tools: search_linkedin"`

For `role: "tool"` with array content:
```typescript
{
  type: "tool-result",
  toolName: "search_linkedin",
  result: "... 5000 char result ..."
}
```

Display as (merged with previous assistant): `"→ Tool results: search_linkedin: [first 50 chars]..."`

---

## Files Changed

- `src/gateway/services/AgentService.ts` - Message breakdown logic in `inspectContext()`

---

## Testing

1. Open context inspector for a conversation with tool calls
2. Verify: No "TOOL" entries shown separately
3. Verify: Tool calls/results shown inline with assistant message
4. Verify: No "system" or summary messages in "Message History" section
5. Verify: Token counts are reasonable (not 9K+ for single message)
