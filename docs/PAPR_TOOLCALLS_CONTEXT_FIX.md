# PAPR Tool Calls and Missing Messages Fix

**Added:** 2026-04-19  
**Issue:** Agent loses tool call context and recent messages when using PAPR Memory

## Problems

When PAPR Memory integration is enabled, the agent would:

1. **Repeat the same work over and over** - Re-running grep, re-discovering same issues
2. **Missing recent messages** - Not seeing assistant responses (both tool results and text)
3. **Appear to have amnesia** - Acting like it never participated in recent conversation

**Example:**
```
User: "what's the email sender job do?"
Agent: [Explains the job in detail with tool calls]
User: "what's the last response you shared?"
Agent: "I don't have context from before this conversation."
       ← Agent can't see its own detailed response from 2 minutes ago!
```

## Root Causes

### Bug 1: Missing `toolCalls` Field in Parsed Messages

**PaprMemoryProvider** wasn't parsing and including `toolCalls` when returning messages for LLM context.

### Bug 2: Default API Limit Too Low with Summaries

**Critical discovery:** When calling `retrieveHistory()` WITHOUT a `limit` parameter, PAPR applies a very restrictive default limit when summaries exist.

**Test Results:**
```bash
# Chat has 12 total messages (6 user + 6 assistant)
# Without limit parameter:
Retrieved 8 messages
Total count: 12
Role distribution: { user: 6, assistant: 2 }  ← Only 2 assistant messages!

# With limit: 100:
Retrieved 12 messages
Total count: 12
Role distribution: { user: 6, assistant: 6 }  ← All messages present!
```

**Why this happens:**
- PAPR creates summaries to compress old conversations
- When summary exists, PAPR returns only "recent" messages after summary cutoff
- Default limit is very small (maybe 10-15 messages)
- Missing assistant responses get filtered out by this limit
- Agent sees incomplete conversation history

## The Fixes

### Fix 1: Parse Tool Calls from PAPR Content

Added `parseMessageForLLM()` helper to extract `toolCalls` from serialized JSON or structured content.

### Fix 2: Request Explicit Limit

Changed `loadMessagesForLLM()` to explicitly request `limit: 100`:

```typescript
const response = await this.client.messages.sessions.retrieveHistory(chatId, {
  limit: 100,  // ← CRITICAL: Request enough messages to get full context
});
```

**Why 100?**
- Most conversations under 100 messages won't have summaries yet
- For conversations >100 messages, we get the 100 most recent + summary
- Balances context completeness vs token usage
- Can be increased to 200 if needed for very active chats

### Fix 3: Enhanced Logging

Added detailed logging to detect these issues:

```typescript
console.log(`[PaprMemoryProvider] 📊 Role distribution:`, roleCount);
console.log(`[PaprMemoryProvider] 📋 All messages from PAPR:`);
response.messages.forEach((m, i) => {
  console.log(`  [${i}] ${m.role} at ${m.timestamp || m.createdAt}`);
});
```

This immediately shows if assistant messages are missing from the API response.

## Impact

**Before Both Fixes:**
- Agent repeated same work every turn
- Agent couldn't see its own recent responses
- Assistant messages mysteriously "disappeared"
- Users had to restart app or start new chats

**After Fix 1 Only (toolCalls parsing):**
- Still missing recent assistant messages
- Agent saw user messages but not its own responses
- Confusing "amnesia" behavior

**After Both Fixes:**
- Agent sees full conversation history ✅
- All assistant responses present with tool calls ✅
- Context preserved across all turns ✅
- Agent continues conversations naturally ✅

## Testing Results

**Test Script:** `test-papr-messages.mjs`

```bash
$ node test-papr-messages.mjs

✓ Retrieved 12 messages
  Total count: 12
Role distribution: { user: 6, assistant: 6 }  ← Perfect!

RECENT ASSISTANT MESSAGES (last 5):
Found 6 assistant messages total  ← All present!
[0] 2026-04-19T17:08:45.123Z
    Here's what the email_sender_scheduled_queue job does: Reads a queue...
[1] 2026-04-19T17:04:30.456Z
    You've got a lot going on. Here's the quick picture: 37 mini-apps...
[2] 2026-04-19T17:02:44.517Z
    Doing well, thanks! Ready to build, automate...
```

## Related Files

- `src/gateway/services/storage/PaprMemoryProvider.ts` - Fixed `loadMessagesForLLM()`, added `parseMessageForLLM()`, added `limit: 100`
- `src/gateway/services/storage/HybridStorageProvider.ts` - Unchanged (correctly prefers PAPR first)
- `src/gateway/services/storage/LocalStorageProvider.ts` - Reference implementation
- `test-papr-messages.mjs` - Test script to verify PAPR API responses

## Key Learnings

1. **Always specify limit explicitly** - Don't rely on API defaults, especially with complex features like summaries
2. **Test with real data** - The bug only appeared in chats with summaries enabled
3. **Log role distribution** - Immediately shows if messages are missing by role
4. **Test via direct API calls** - Bypass app code to verify what the API actually returns

## Prevention

1. **Explicit limits in all API calls** - Never rely on defaults
2. **Role distribution logging** - Catch missing messages early
3. **Test with summaries** - Ensure limit handles summary + recent messages correctly
4. **Monitor message counts** - Alert if retrieved count << total count
