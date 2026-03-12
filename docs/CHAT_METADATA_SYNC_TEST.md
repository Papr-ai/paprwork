# Testing Chat Metadata Synchronization

**Date:** 2026-03-10  
**Issue:** Investigating if `message_count` is stale when loading messages for LLM
**Status:** 🔍 TESTING

## Hypothesis

The issue might be that when `loadMessagesForLLM()` reads chat metadata, the `message_count` hasn't been updated yet from the most recent `saveMessage()` call.

### Sequence That Could Cause Issues

```
1. Chat has 50 messages (message_count = 50)
2. User sends new message
3. saveMessage() inserts message #51
4. saveMessage() runs UPDATE to set message_count = 51
5. loadMessagesForLLM() runs SELECT to get chat metadata
   ❓ Does it see message_count = 50 (stale) or 51 (updated)?
```

If it sees **50 (stale)**, then the query `ORDER BY timestamp DESC LIMIT 15` might be returning the wrong 15 messages.

## What We Added

### 1. Verify Update Worked

In `saveMessage()` after the UPDATE:

```typescript
const updateResult = this.db
  .prepare(`UPDATE chats SET message_count = message_count + 1 ...`)
  .run(...);

// Verify immediately after
const updatedChat = this.db
  .prepare(`SELECT id, message_count FROM chats WHERE id = ?`)
  .get(chatId);

console.log(`📊 Chat stats after save: message_count=${updatedChat?.message_count} (changes=${updateResult.changes})`);
```

This shows:
- **changes**: Number of rows affected (should be 1)
- **message_count**: The actual count after the update

### 2. Log When Loading

In `loadMessagesForLLM()` at the start:

```typescript
console.log(`📥 loadMessagesForLLM called for chat ${chatId}`);
console.log(`📊 Chat metadata: message_count=${chat.message_count}, has_summary=${!!chat.summary_long}`);
console.log(`🔎 Summary exists - querying for ${recentMessageLimit} most recent messages...`);
```

This shows what `message_count` the query sees.

## Expected Logs

**Healthy flow:**
```
[LocalStorage] 💾 Saving message to chat abc123:
  timestamp: "2026-03-10T15:30:00.000Z"
  
[LocalStorage] ✅ Message saved successfully
[LocalStorage] 📊 Chat stats after save: message_count=51 (changes=1)

[LocalStorage] 📥 loadMessagesForLLM called for chat abc123
[LocalStorage] 📊 Chat metadata: message_count=51, has_summary=true
[LocalStorage] 🔎 Summary exists - querying for 15 most recent messages...

[LocalStorage] 🔍 Query returned 15 messages (DESC order):
  0. [2026-03-10T15:30:00.000Z] user: "new message..."  ← Newest!
```

**Problem flow (if metadata is stale):**
```
[LocalStorage] 💾 Saving message to chat abc123:
  timestamp: "2026-03-10T15:30:00.000Z"
  
[LocalStorage] ✅ Message saved successfully
[LocalStorage] 📊 Chat stats after save: message_count=51 (changes=1)

[LocalStorage] 📥 loadMessagesForLLM called for chat abc123
[LocalStorage] 📊 Chat metadata: message_count=50, has_summary=true  ← STALE!
[LocalStorage] 🔎 Summary exists - querying for 15 most recent messages...

[LocalStorage] 🔍 Query returned 15 messages (DESC order):
  0. [OLD TIMESTAMP] assistant: "old message..."  ← Wrong!
```

## Possible Causes

### 1. SQLite Transaction Isolation

SQLite's default isolation level might cause the SELECT in `loadMessagesForLLM()` to see a snapshot from before the UPDATE.

**Solution:** Use `PRAGMA read_uncommitted = 1` or ensure all operations are in the same transaction.

### 2. WAL Mode Lag

better-sqlite3 uses WAL (Write-Ahead Logging) mode. Reads might see data from before the most recent write is checkpointed.

**Solution:** Call `db.pragma('wal_checkpoint(PASSIVE)')` after critical writes, or use `db.transaction()` to group related operations.

### 3. Cached Query Results

The prepared statement might be caching results.

**Solution:** Should not happen with better-sqlite3, but we can verify by running a new prepare() each time.

## Testing Steps

1. **Restart app** to get clean logs
2. **Send message** in problematic chat
3. **Check logs** for:
   - Does `message_count` increment correctly after save?
   - Does `loadMessagesForLLM` see the updated count?
   - If counts match, are the RIGHT messages being returned?

## If Issue Found

### If `changes=0` in update result:
The UPDATE isn't finding the chat row. Check:
- Is `chatId` correct?
- Does the chat exist?
- Is there a constraint preventing the update?

### If `message_count` is stale in load:
The SELECT is seeing old data. Solutions:
- Wrap save+load in a transaction
- Force WAL checkpoint after save
- Use `PRAGMA synchronous = FULL`

### If counts match but wrong messages returned:
The query `ORDER BY timestamp DESC LIMIT 15` is working, but the issue is elsewhere:
- Check message timestamps
- Check if there's a WHERE clause filtering messages
- Check if messages are being deleted

## Files Changed

- `src/gateway/services/storage/LocalStorageProvider.ts`
  - Added verification logging to `saveMessage()`
  - Added detailed logging to `loadMessagesForLLM()`
