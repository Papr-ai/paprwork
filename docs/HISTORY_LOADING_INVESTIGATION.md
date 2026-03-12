# History Loading Investigation - Missing Recent Messages After Summarization

**Date:** 2026-03-10
**Issue:** After summarization happens, newest messages are excluded from LLM context
**Status:** 🔍 INVESTIGATING

## Problem Description

After a conversation reaches the summarization threshold (~50 messages or 50K tokens), recent messages are being excluded from the LLM context. The Context Inspector shows old messages (e.g., "I can't create accounts...") but newer messages sent after that are missing.

### User Report

> "this is the last assistant message that shows up in context history: assistant 164 tokens 'I can't create accounts on your behalf — Apollo needs your email...'"
>
> "however, this is an old message.. there are a bunch of newer messages (multiple ones) that aren't in context. The llm gets confused when i talk to it because it seems like the most recent messages don't get sent to it after a summary happens or after the convo context goes above 50.. something weird is happening.. we remove the oldest and newest messages"

## Investigation Steps

### Step 1: Understanding the Flow

**When NO summary exists:**
```typescript
// Line 345-351 in LocalStorageProvider.ts
if (!chat.summary_long) {
  const messages = await this.loadMessages(chatId);
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
  }));
}
```
✅ Returns ALL messages - this works fine

**When summary EXISTS:**
```typescript
// Line 358: Limit to 15 most recent messages
const recentMessageLimit = chat.summary_long ? 15 : 50;

// Line 360-368: Query for recent messages
const recentMessages = this.db
  .prepare(`
    SELECT role, content, thinking, tool_calls
    FROM messages 
    WHERE chat_id = ? 
    ORDER BY timestamp DESC 
    LIMIT ?
  `)
  .all(chatId, recentMessageLimit) as any[];

// Line 371: Reverse to chronological order
recentMessages.reverse();
```
🔍 Should return 15 most recent messages, but user reports old messages instead

### Step 2: Possible Causes

1. **Timestamp Issue**: Message timestamps might not be properly sorted
   - New messages getting wrong timestamps?
   - Timestamp format inconsistency (ISO string vs timestamp)?

2. **Query Timing Issue**: Chat metadata might be stale
   - `chat.message_count` queried before new message is saved?
   - But we `await` saveMessage before loadMessagesForLLM...

3. **Database Isolation/Transaction Issue**: 
   - SQLite write not committed before read?
   - WAL mode issue?

4. **Limit Calculation Wrong**:
   - `recentMessageLimit` of 15 is too small?
   - But even if 15 is small, it should be the MOST RECENT 15, not old ones

### Step 3: Added Debugging Logs

**In `saveMessage()`:**
```typescript
console.log(`[LocalStorage] 💾 Saving message to chat ${chatId}:`, {
  id: message.id,
  role: message.role,
  timestamp: timestamp,
  contentPreview: message.content?.substring(0, 50) + '...',
  // ...
});
```

**In `loadMessagesForLLM()`:**
```typescript
console.log(`[LocalStorage] 🔍 Query returned ${recentMessages.length} messages (DESC order):`);
recentMessages.forEach((msg, i) => {
  const preview = typeof msg.content === 'string' ? msg.content.substring(0, 50) : '';
  console.log(`  ${i}. [${msg.timestamp}] ${msg.role}: "${preview}..."`);
});
```

### Step 4: What to Look For in Logs

When user sends a message, we should see:

1. **Save operation:**
   ```
   [LocalStorage] 💾 Saving message to chat abc123:
     timestamp: "2026-03-10T12:34:56.789Z"
     contentPreview: "yes this feels better..."
   [LocalStorage] ✅ Message saved successfully
   ```

2. **Load operation:**
   ```
   [LocalStorage] 🔍 Query returned 15 messages (DESC order):
     0. [2026-03-10T12:34:56.789Z] user: "yes this feels better..."  ← NEWEST (just saved)
     1. [2026-03-10T12:30:00.000Z] assistant: "I can't create..."
     2. [2026-03-10T12:25:00.000Z] user: "can you get one..."
     ...
     14. [older timestamp] role: "older message..."
   ```

If the newest message is NOT #0 in the DESC list, we have a timestamp problem!

## Hypothesis

Based on the user's description ("we remove the oldest and newest messages"), I suspect one of:

1. **Wrong ORDER BY**: Maybe timestamp sorting is inverted somewhere
2. **Timestamp Format Issue**: Timestamps might be strings that don't sort correctly
3. **LIMIT applied BEFORE ORDER BY** (shouldn't be possible in SQL but worth checking)

## Testing Plan

1. User should send a new message in the problematic chat
2. Check Gateway logs for the debug output
3. Verify:
   - Is the new message's timestamp correct?
   - Is it appearing as index 0 in the DESC query?
   - If not, what index is it at?
   - What are the timestamps of the messages around it?

## Related Files

- `src/gateway/services/storage/LocalStorageProvider.ts` - Line 327-430 (loadMessagesForLLM)
- `src/gateway/services/storage/LocalStorageProvider.ts` - Line 208-265 (saveMessage)
- `src/gateway/services/AgentService.ts` - Line 295-310 (save then load flow)

## Next Steps

Once we have the log output, we can:
1. Identify if it's a timestamp issue
2. Identify if it's a query ordering issue
3. Fix the root cause
4. Ensure Context Inspector shows correct messages
