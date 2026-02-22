# 🚨 AGENT TRACKING BUG FOUND!

## Test Results

**Date:** 2026-02-20  
**Database:** `~/.paprwork-v2/chats.db` (41MB, 531 messages)

### ✅ What Works

**Schema is Perfect:**
```sql
-- All required columns exist:
- total_tokens INTEGER
- prompt_tokens INTEGER  
- completion_tokens INTEGER
- cost REAL
- source_agent_id TEXT
- source_agent_name TEXT
- model TEXT
```

**Messages are being saved:**
- 531 total messages in database
- Models are being captured (`gpt-5.2-codex`, `claude-sonnet-4-6`, etc.)
- Agent attribution is working (`source_agent_id = 'main-agent'`)

### ❌ What's Broken

**ZERO token/cost tracking:**
```sql
SELECT COUNT(*) as total, 
       COUNT(CASE WHEN total_tokens > 0 THEN 1 END) as with_tokens,
       COUNT(CASE WHEN cost > 0 THEN 1 END) as with_cost
FROM messages;

Result: 531 | 0 | 0
```

**Every single message has:**
- `total_tokens = 0`
- `prompt_tokens = 0`
- `completion_tokens = 0`
- `cost = 0.0`

## Root Cause Analysis

The token data is **not being captured from AI responses** and saved to the database.

### Where to Look

1. **Stream Orchestrator** (`src/gateway/services/agent/streamOrchestrator.ts`)
   - Lines 235-242: Token accumulation from chunks
   - Line 289: Cost calculation
   - Check if `chunkUsage` is actually present in stream chunks

2. **Message Persistence** (`src/gateway/services/agent/messagePersistence.ts`)
   - Check if usage data is being passed to `saveMessage()`
   - Verify the object structure being saved

3. **AI SDK Integration**
   - Check if Mastra/AI SDK is actually returning usage data
   - Some models/providers don't return usage until stream completes

## Reproduction

```bash
# 1. Check current data
sqlite3 ~/.paprwork-v2/chats.db "SELECT total_tokens, cost FROM messages WHERE role='assistant' LIMIT 5;"

# Expected: All zeros (BUG)
# Should be: Non-zero values for tokens and cost
```

## Next Steps

1. **Add debug logging** to see if usage data is in stream chunks
2. **Check AI SDK response** - maybe usage isn't in `chunkUsage`
3. **Verify message save** - ensure usage object is being passed
4. **Test with different providers** - OpenAI vs Anthropic vs Google

## Impact

- ❌ Agents page shows $0 cost for all activity
- ❌ Token usage cards show 0 tokens
- ❌ Cost trends show no data
- ❌ Model distribution shows empty
- ✅ Everything else works (attribution, plans, documents, apps)

## Recommended Fix

Add logging to `streamOrchestrator.ts` to see what's in the chunks:

```typescript
// Line ~235
if (chunkUsage) {
  console.log('[DEBUG] Token usage from chunk:', chunkUsage);
  totalTokens += chunkUsage.totalTokens || 0;
  // ...
}

// Line ~289
console.log('[DEBUG] Saving message with usage:', {
  totalTokens,
  promptTokens,
  completionTokens,
  cost
});
```

Then send a message and check the logs!

---

**This is a critical bug - the entire agent metrics dashboard depends on this data!** 🔥
