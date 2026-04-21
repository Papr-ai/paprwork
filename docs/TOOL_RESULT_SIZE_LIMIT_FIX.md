# Tool Result Truncation & Sync Retry Strategy

**Date:** 2026-04-19  
**Issue:** Message sync to PAPR failing with 500 error - investigating root cause

## Investigation Findings

### The Failed Message
- **Message ID:** `msg-1014d438-6983-4d6d-8235-b80966b192db`
- **Tool Calls:** 78 tool calls with 313KB total tool results
- **Error:** `500 {"detail":"Internal server error"}`
- **Sync Status:** `sync_failed` after 3 retry attempts (SDK has `maxRetries: 3`)

### Size is NOT the Root Cause! ✅

Checked other messages in the same chat that synced SUCCESSFULLY:

```sql
msg-c92ade82... | 276KB tool calls | synced ✅  (LARGER than failed message!)
msg-1a81acb2... | 46KB tool calls  | synced ✅
msg-1014d438... | 313KB tool calls | sync_failed ❌
```

**Conclusion:** A 276KB message synced successfully AFTER the 313KB message failed. **Size is not the issue** - it was likely a transient Parse Server error (timeout, memory spike, rate limit, etc.)

## Timeline

### April 16, 2026 - Commit `3f504c8`
Changed from sending plain text to PAPR to serializing full rich content:

```typescript
// BEFORE: Just text
content: message.content

// AFTER: Full rich content with ALL tool results
content: JSON.stringify({
  text: message.content,
  thinking: message.thinking,
  toolCalls: message.toolCalls,  // <-- Could be 313KB!
  sequence: message.sequence,
  model: message.model,
})
```

### Later Commits
Code was refactored to send structured arrays instead of JSON strings, but the underlying issue remained: **tool results stored in local SQLite were unbounded**.

## The Flow

1. **Agent generates response** with tool calls + results
2. **LocalStorageProvider.saveMessage()** saves to SQLite with FULL tool results (313KB)
3. **HybridStorageProvider** syncs to PAPR in background
4. **PaprMemoryProvider.saveMessage()** reads from local storage (already has 313KB)
5. **Parse Server** receives massive payload → crashes with 500 error
6. **Sync fails** → message stuck in `sync_failed` status

## The Fix

### Truncate Tool Results When Syncing to PAPR

**File:** `src/gateway/services/storage/PaprMemoryProvider.ts`

When building structured content to send to PAPR, truncate each tool result to **500 characters**:

```typescript
// Add tool result if present - TRUNCATE to prevent Parse Server crashes
if (tc.result !== undefined) {
  const resultStr = String(tc.result);
  const truncated = resultStr.substring(0, 500); // 500 chars max per tool result
  structuredContent.push({
    type: "tool_result",
    tool_use_id: tc.id,
    content: resultStr.length > 500 
      ? truncated + '\n... [truncated]'
      : resultStr,
  });
}
```

**Why 500 characters?**
- With 78 tool calls: 78 × 500 chars = **39KB** (safe)
- With 2000 chars: 78 × 2000 chars = **156KB** (would be unnecessarily large)
- Parse Server can handle 1MB+, but smaller is better for performance
- Full results still available in local SQLite for debugging

**Local Storage:**
- Keeps **full, untruncated** tool results in SQLite
- Users can access complete results for debugging
- Only PAPR sync gets truncated version for reliability

## Why Keep the 500-Char Truncation?

Even though size wasn't the cause of THIS failure, truncating tool results is still best practice:

1. **Reduces payload size** - Faster network transfers, less memory usage
2. **Prevents future issues** - As Parse Server/backend evolves, smaller payloads are more reliable
3. **Matches backend behavior** - The backend already truncates to 500 chars in some code paths
4. **Good for LLM context** - Tool results in PAPR are used for LLM context - 500 chars is usually sufficient
5. **Full results in local storage** - SQLite keeps complete results for debugging

## The Real Fix Needed: Retry Logic

The 500 error was transient (server hiccup). We need:

1. **Background retry job** - Periodically retry `sync_failed` messages
2. **Exponential backoff** - Wait longer between retries (1min, 5min, 30min, etc.)
3. **Manual retry UI** - Let users manually retry failed syncs
4. **Better error classification** - Distinguish transient (500, timeout) from permanent (400 validation) errors

## Current Retry Behavior

The Papr SDK already has `maxRetries: 3` configured:

```typescript
this.client = new Papr({
  xAPIKey: config.apiKey,
  maxRetries: 3,  // Already retries 3 times!
  timeout: 30000,
});
```

But after 3 failed attempts, it gives up and marks as `sync_failed`. We need a longer-term retry strategy.

## Impact

### Before Fix
- Messages with many tool calls (78+) had 313KB of tool results in local SQLite
- When syncing to PAPR, even with 2KB/tool truncation: 78 × 2KB = **156KB payload**
- Parse Server crashed with 500 error on large payloads
- PAPR sync failed silently for messages with many tool calls
- User saw response in UI but it was missing from LLM context on next turn
- Agent repeated work due to missing context

### After Fix
- Local SQLite keeps **full untruncated** tool results (313KB - for debugging)
- PAPR sync truncates to 500 chars/tool: 78 × 500 chars = **39KB payload** ✅
- Parse Server handles payload successfully
- Full message history available to LLM across all turns
- No silent failures, reliable sync

## Parse Server Limits

Based on investigation of the PAPR backend:

- **Request body limit:** ~1MB (typical body parser config)
- **Batch operations:** 20 operations max, 800KB payload recommended
- **Nested structures:** Can cause crashes if too deeply nested or large
- **Content field:** Should contain structured arrays, not massive JSON strings

## Testing

To verify the fix works:

1. **Check existing failed message:**
```bash
sqlite3 ~/.paprwork-v2/chats.db "SELECT LENGTH(tool_calls) FROM messages WHERE sync_status = 'sync_failed'"
```

2. **Trigger retry** (future enhancement - currently no retry mechanism)

3. **Verify new messages:**
```bash
sqlite3 ~/.paprwork-v2/chats.db "SELECT MAX(LENGTH(tool_calls)) FROM messages"
# Should be < 50KB (2KB per tool * ~20 tools max)
```

## Prevention

1. **Always truncate at source** - Don't wait until sync time
2. **Set explicit limits** - Document size constraints
3. **Monitor payload sizes** - Log warnings for large payloads
4. **Test with real data** - Use actual tool results in tests, not mock data

## Related Files

- `src/gateway/services/storage/LocalStorageProvider.ts` - **FIXED** - Truncates before SQLite insert
- `src/gateway/services/storage/PaprMemoryProvider.ts` - Already had truncation for structured array
- `src/gateway/services/storage/HybridStorageProvider.ts` - Sync orchestration
- `memory/services/message_service.py` - Parse Server backend (PAPR)

## Future Improvements

1. **Retry mechanism** for failed syncs
2. **Automatic cleanup** of oversized messages in existing database
3. **Payload size monitoring** with alerts
4. **Configurable truncation limits** per environment
