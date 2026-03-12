# Summarization Not Triggering - Token Count Issue

**Date:** 2026-03-10  
**Issue:** Summarization threshold (50K tokens) not being reached even in long conversations  
**Root Cause:** Token counts not being tracked properly for all messages  
**Status:** 🔍 DIAGNOSED

## The Real Problem

When you closed and re-opened the app, the **most recent messages appeared in context**. This means:
- ✅ Messages ARE being saved correctly
- ✅ Messages ARE being loaded correctly  
- ❌ Summarization is NOT triggering when it should

### Why Summarization Isn't Happening

Summarization triggers when `token_count > 50000` (line 1200 in `AgentService.ts`):

```typescript
const stats = await this.storageManager.getChatStats(chatId);
if (stats.token_count > 50000) {
  this.triggerSummarization(chatId).catch(console.error);
}
```

But `token_count` is calculated from the database:

```sql
SELECT COALESCE(SUM(total_tokens), 0) as token_count
FROM messages 
WHERE chat_id = ?
```

**The problem:** Only **assistant messages** have `total_tokens` set (from the API response). **User messages** don't have token counts!

### Example Scenario

```
Chat with 50 messages (25 user + 25 assistant):
- User messages: 0 tokens tracked (not counted!)
- Assistant messages: 30K tokens tracked
- Total in DB: 30K tokens
- Threshold: 50K tokens
- Result: No summarization! ❌
```

But the **actual context** being sent to the LLM is much larger:
- User messages: ~20K tokens (estimated)
- Assistant messages: ~30K tokens
- **Actual total: ~50K tokens** (should trigger summarization!)

## Why This Causes Missing Messages

Without summarization:
1. Chat has 50 messages (no summary exists)
2. `loadMessagesForLLM()` sees `summary_long = null`
3. Returns ALL 50 messages (line 346-351)
4. All messages are included in context ✅

But once you manually create a summary (or it triggers for another reason):
1. Chat has 50 messages (summary now exists)
2. `loadMessagesForLLM()` sees `summary_long != null`  
3. Returns only LAST 15 messages (line 358-368)
4. **OLD messages might be in those 15** if timestamps are wrong ❌

## The Fix

We need to either:

### Option A: Estimate User Message Tokens (Quick Fix)
When saving user messages, estimate their token count:

```typescript
async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
  // Estimate tokens for user messages (1 token ≈ 4 chars)
  if (message.role === 'user' && !message.total_tokens) {
    const estimatedTokens = Math.ceil((message.content?.length || 0) / 4);
    message.total_tokens = estimatedTokens;
    message.prompt_tokens = estimatedTokens;
  }
  
  // ... rest of save logic
}
```

### Option B: Use Message Count Instead (Alternative)
Change threshold to message count instead of tokens:

```typescript
// Trigger at 40+ messages instead of 50K tokens
if (stats.message_count > 40) {
  this.triggerSummarization(chatId);
}
```

### Option C: Calculate Actual Context Size (Best)
Calculate the actual size of what we're sending to the LLM:

```typescript
const messages = buildModelMessages(history, userMessage, systemPrompt);
const contextSize = JSON.stringify(messages).length;
const estimatedTokens = Math.ceil(contextSize / 4);

if (estimatedTokens > 50000) {
  this.triggerSummarization(chatId);
}
```

## What the Logging Will Show

With the new logging, after each message you'll see:

```bash
[LocalStorage] 📊 getChatStats for abc123:
  message_count: 50
  token_count: 30000  ← Too low! Should be ~50K
  messages_with_tokens: 25  ← Only assistant messages counted!
  has_summary: false

[AgentService] 📊 Chat stats after stream: 
  message_count=50, token_count=30000, has_summary=false
  
[AgentService] ℹ️  Token count (30000) below 50K threshold - no summarization needed
```

This confirms the issue: `token_count` is artificially low because user messages aren't counted.

## Recommended Fix

**Option A (Quick)** - Estimate user message tokens when saving:

1. Easy to implement (just estimate `~content.length / 4`)
2. Accurate enough for triggering summarization
3. No breaking changes to existing logic
4. Can be done right now

Then the logs would show:
```bash
[LocalStorage] 📊 getChatStats for abc123:
  message_count: 50
  token_count: 52000  ← Correct! Includes user messages
  messages_with_tokens: 50  ← All messages counted!
  has_summary: false

[AgentService] 🔄 Token count (52000) > 50K threshold - triggering summarization
```

## Files to Modify

1. **src/gateway/services/storage/LocalStorageProvider.ts**
   - Add token estimation in `saveMessage()` for user messages

2. **src/gateway/services/AgentService.ts** 
   - Already has logging to confirm fix works

## Testing

After implementing the fix:
1. Send a few messages
2. Check logs for `token_count` 
3. Verify it increases for both user AND assistant messages
4. Verify summarization triggers at ~50K tokens

## Why You Saw It Work After Restart

When you restarted, the app:
1. Loaded the chat (no summary yet)
2. `loadMessagesForLLM()` returned ALL messages (no 15-message limit)
3. Context Inspector showed all recent messages ✅

But without proper summarization, eventually:
1. Context gets too large
2. Manual summary gets created somehow (maybe from PAPR sync?)
3. Next load only gets 15 messages
4. Older messages show up if timestamps are wrong
