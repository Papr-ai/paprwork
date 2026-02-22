# 🎯 TOKEN TRACKING BUG - FOUND & FIXED!

**Date:** 2026-02-20  
**Status:** ✅ FIXED - Awaiting Test

---

## The Bug

**ALL 531 messages in the database had ZERO token/cost data**

```sql
SELECT total_tokens, cost FROM messages WHERE role='assistant';
-- Result: Every row = 0, 0.0
```

## Root Cause Analysis

### The Investigation Path

1. **Schema** ✅ Perfect - all columns exist
2. **Message saving** ✅ Working - 531 messages saved
3. **Code review** ✅ Token extraction code exists in AgentService
4. **The problem:** Token data was never being extracted!

### The Actual Bug

**Location:** `src/gateway/services/agent/streamOrchestrator.ts`

The AI SDK emits usage data in a **`finish-step`** event, but our orchestrator:
- ❌ Only handled `case "finish"` (which has NO usage data)
- ❌ Completely ignored `case "finish-step"` (which HAS usage data)
- ❌ Never yielded a `done` chunk with usage for AgentService to capture

### AI SDK Event Structure

```typescript
// What AI SDK emits (from node_modules/ai/dist/index.d.ts):
{
  type: 'finish-step',
  usage: {
    inputTokens: number,      // Prompt tokens
    outputTokens: number,     // Completion tokens
    totalTokens: number
  },
  finishReason: string
}

// What our code was looking for:
{
  type: 'done',  // This never came!
  payload: { usage: { ... } }
}
```

## The Fix

**File:** `src/gateway/services/agent/streamOrchestrator.ts`  
**Lines:** Added `case "finish-step"` handler before `case "finish"`

```typescript
case "finish-step": {
  // AI SDK provides usage data in finish-step events
  const finishStepChunk = rawChunk as {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
    finishReason?: string;
  };
  
  if (finishStepChunk.usage) {
    const usage = finishStepChunk.usage;
    console.log(
      `[StreamOrchestrator] 💰 Usage from finish-step: ` +
      `${usage.totalTokens || 0} total ` +
      `(${usage.inputTokens || 0} input + ${usage.outputTokens || 0} output)`
    );
    
    // Yield a done chunk with usage for AgentService to capture
    yield createChatStreamChunk(
      "done",
      {
        usage: {
          promptTokens: usage.inputTokens || 0,
          completionTokens: usage.outputTokens || 0,
          totalTokens: usage.totalTokens || 0,
        },
      },
      chatId,
    );
  }
  
  const finishReason = finishStepChunk.finishReason;
  if (finishReason === "length") {
    console.warn(
      `[StreamOrchestrator] ⚠️ Model stopped due to TOKEN LIMIT! Consider increasing maxTokens.`,
    );
  }
  break;
}
```

### What This Does

1. **Intercepts** the `finish-step` event from AI SDK
2. **Extracts** usage data (inputTokens, outputTokens, totalTokens)
3. **Converts** AI SDK format → our format (promptTokens, completionTokens, totalTokens)
4. **Yields** a `done` chunk that AgentService expects (line 746 in AgentService.ts)
5. **Logs** usage for debugging

## Testing

### How to Verify Fix

1. **Restart the app** (rebuild already done)
   ```bash
   # App should pick up new dist/ files automatically
   # Or: npm start
   ```

2. **Send a test message**
   ```
   User: "Say hello in 5 words"
   ```

3. **Check the database**
   ```bash
   sqlite3 ~/.paprwork-v2/chats.db \
     "SELECT role, model, total_tokens, cost FROM messages ORDER BY timestamp DESC LIMIT 5;"
   ```

4. **Expected Result:**
   ```
   assistant|gpt-4o-mini|1234|0.0012
   user||0|0.0
   assistant|gpt-4o-mini|987|0.0009
   ...
   ```

### What to Look For

- ✅ `total_tokens > 0` for assistant messages
- ✅ `cost > 0` for assistant messages
- ✅ Console logs: `[StreamOrchestrator] 💰 Usage from finish-step: ...`
- ✅ Console logs: `[AgentService] 💰 Token usage: ...`

## Impact

Once fixed and tested:
- ✅ Agents page will show real costs
- ✅ Token usage cards will show actual tokens
- ✅ Cost trends will populate
- ✅ Model distribution will show accurate data
- ✅ All 9 dashboard cards will have real data

## Files Changed

1. **`src/gateway/services/agent/streamOrchestrator.ts`**
   - Added `finish-step` case handler
   - Extracts usage from AI SDK event
   - Yields `done` chunk with usage

## Why This Wasn't Caught Earlier

1. **The code looked correct** - AgentService has token extraction logic
2. **No errors thrown** - Just silently resulted in 0 values
3. **Chunk type mismatch** - We looked for `done`, AI SDK sends `finish-step`
4. **Different property names** - AI SDK uses `inputTokens`/`outputTokens`, we expected `promptTokens`/`completionTokens`

## Related Documentation

- AI SDK types: `node_modules/ai/dist/index.d.ts` (lines with `TextStreamPart`)
- Usage extraction: `src/gateway/services/AgentService.ts` (lines 745-759)
- Message persistence: `src/gateway/services/agent/messagePersistence.ts`
- Cost calculation: `src/core/agents/pricing.ts`

---

**Next Step:** User needs to restart app and send a test message to verify the fix! 🚀
