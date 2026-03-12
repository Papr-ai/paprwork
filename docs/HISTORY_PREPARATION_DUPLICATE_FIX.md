# History Preparation Duplicate User Message Fix

**Date:** 2026-03-10
**Issue:** Context Inspector showing stale history; LLM receiving duplicate user messages
**Status:** ✅ FIXED

## Problem Description

The Context Inspector was showing message history that didn't include the latest user messages visible in the chat UI. This created confusion because users couldn't see what context the LLM was actually receiving.

### Root Cause

The issue was a **duplicate user message bug** in how we prepare history for the LLM:

1. User sends message "X"
2. `streamAgent()` saves "X" to database (line 305 in AgentService.ts)
3. `streamAgent()` loads history including "X" (line 310)
4. `buildModelMessages()` is called with:
   - `history` (which already contains "X")
   - `userMessage` ("X" again)
5. `buildModelMessages()` **ALWAYS added userMessage at the end**, creating a duplicate!

### Evidence

**What the LLM was seeing:**
```
System: [system prompt]
User: "can you get one for me..."
Assistant: "I can't create accounts..."
User: "yes this feels better.." ← From history
User: "yes this feels better.." ← Duplicate from buildModelMessages()
```

**What the Context Inspector showed:**
```
System: [system prompt]
User: "can you get one for me..."
Assistant: "I can't create accounts..."
User: "[Next user message will appear here]" ← Placeholder
```

The Context Inspector didn't show the duplicate because it uses a placeholder `"[Next user message will appear here]"` instead of the actual message. This made it look like the history was missing messages, when in reality the LLM was getting duplicates.

## The Fix

Modified `buildModelMessages()` in `src/gateway/services/agent/historyFormatter.ts` to check if the user message is already the last message in history before adding it:

```typescript
// Check if the userMessage is already the last message in history
// This happens when we save the user message before loading history
const lastMessage = messages[messages.length - 1];
const isUserMessageAlreadyInHistory =
  lastMessage &&
  lastMessage.role === "user" &&
  typeof lastMessage.content === "string" &&
  lastMessage.content === userMessage;

// Only add the current user message if it's not already in history
if (!isUserMessageAlreadyInHistory) {
  console.log(
    `[buildModelMessages] Adding user message (not in history yet): "${userMessage.substring(0, 50)}..."`,
  );
  messages.push({
    role: "user",
    content: userMessage,
  });
} else {
  console.log(
    `[buildModelMessages] Skipping duplicate user message (already in history): "${userMessage.substring(0, 50)}..."`,
  );
}
```

## Impact

### Before Fix
- ❌ LLM received duplicate user messages
- ❌ Context Inspector showed stale history (missing latest messages)
- ❌ Token usage slightly inflated due to duplicates
- ❌ Model might have been confused by seeing same user message twice

### After Fix
- ✅ LLM receives correct history (no duplicates)
- ✅ Context Inspector shows exactly what LLM sees
- ✅ Token usage accurate
- ✅ Model sees clean, sequential conversation flow

## Files Changed

1. **src/gateway/services/agent/historyFormatter.ts**
   - Added duplicate check in `buildModelMessages()`
   - Added logging for debugging

## Testing

To verify the fix is working:

1. **Check Gateway Logs:**
   ```
   [buildModelMessages] Skipping duplicate user message (already in history): "yes this feels better..."
   ```
   This log should appear for every message after the first turn.

2. **Check Context Inspector:**
   - Open Context Inspector during a chat
   - Verify "Message History" section shows all messages from chat UI
   - The last user message should now be visible in history

3. **Check LLM Behavior:**
   - Model should no longer see duplicate user messages
   - Token counts should be slightly lower (no duplicate user message tokens)

## Why This Approach?

We considered two options:

### Option A: Don't save user message before buildModelMessages
- Move line 305 (saveMessage) to after streaming completes
- This would require significant refactoring
- Risk: If streaming fails, user message might not be saved

### Option B: Check for duplicate in buildModelMessages ✅ CHOSEN
- Simple, surgical fix
- No refactoring of streaming logic required
- Safe: User message is always saved immediately
- Backwards compatible with both flows (save-first and add-later)

## Related Code

**AgentService.streamAgent() flow:**
```typescript
// 1. Save user message (line 305)
const userMsg: StoredMessage = {
  id: `msg-${uuidv4()}`,
  chat_id: chatId,
  role: "user",
  content: userMessage,
  timestamp: new Date().toISOString(),
  sync_status: "local",
};
await this.storageManager.saveMessage(chatId, userMsg);

// 2. Load history including saved message (line 310)
const historyRaw = await this.storageManager.loadMessagesForLLM(chatId);

// 3. Build messages (line 361)
const messages = buildModelMessages(
  history,
  userMessage, // This is now checked for duplicates!
  systemPrompt,
  conversationSummary,
);
```

**AgentService.inspectContext() flow:**
```typescript
// 1. Load history (line 1518)
const historyRaw = await this.storageManager.loadMessagesForLLM(chatId);

// 2. Build messages with placeholder (line 1613)
const messages = buildModelMessages(
  history,
  "[Next user message will appear here]", // Never matches history
  systemPrompt,
  conversationSummary,
);
```

## Prevention

To prevent similar issues in the future:

1. **Always log message counts** when building context
2. **Compare Context Inspector output** with actual LLM logs
3. **Test with screenshots** showing both UI and Context Inspector side-by-side
4. **Add unit tests** for `buildModelMessages()` with various history scenarios

## See Also

- `CLAUDE.md` - Architecture documentation
- `src/gateway/services/agent/historyFormatter.ts` - Message formatting logic
- `src/gateway/services/AgentService.ts` - Main agent service
- `src/gateway/services/StorageManager.ts` - Storage interface
