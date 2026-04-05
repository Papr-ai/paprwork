# Token Usage and Cost Tracking Status

**Date:** 2026-02-20  
**Status:** ⚠️ **PARTIALLY IMPLEMENTED** - Captured but NOT Persisted

---

## Current Implementation

### ✅ What We're Doing Right

#### 1. **Token Usage Capture** (Working)
We ARE capturing token usage from Mastra/AI SDK:

```typescript
// src/core/agents/MastraAgent.ts:234-244
const doneChunk: StreamChunk = {
  type: "done",
  payload: {
    usage: output.totalUsage
      ? {
          promptTokens: (output.totalUsage as any).promptTokens || 0,
          completionTokens: (output.totalUsage as any).completionTokens || 0,
          totalTokens: output.totalUsage.totalTokens || 0,
        }
      : undefined,
  },
  timestamp: new Date().toISOString(),
};
```

#### 2. **Database Schema** (Ready)
The database schema SUPPORTS token tracking:

```sql
-- src/gateway/services/storage/LocalStorageProvider.ts:92-94
prompt_tokens INTEGER DEFAULT 0,
completion_tokens INTEGER DEFAULT 0,
total_tokens INTEGER DEFAULT 0,
```

#### 3. **Type Definitions** (Complete)
The `StoredMessage` interface includes token fields:

```typescript
// src/gateway/services/storage/IStorageProvider.ts:36-38
model?: string;
prompt_tokens?: number;
completion_tokens?: number;
total_tokens?: number;
```

---

## ❌ What's Missing

### Critical Gap: Token Data Not Being Saved

**Problem:** We capture usage in the "done" chunk but DON'T extract and persist it when saving messages.

**Evidence:**
```typescript
// src/gateway/services/AgentService.ts:738-747
const assistantMsg: StoredMessage = createAssistantStoredMessage({
  chatId,
  model: config.model,
  assistantText,
  thinkingText,
  toolCalls,
  toolResults,
  sequence,
  // ❌ NO TOKEN USAGE PASSED HERE
});
await this.storageManager.saveMessage(chatId, assistantMsg);
```

**Result:** 
- ✅ Tokens are captured from Mastra
- ✅ Tokens are sent in "done" chunk
- ❌ Tokens are NOT extracted from done chunk
- ❌ Tokens are NOT passed to `createAssistantStoredMessage()`
- ❌ Tokens are NOT saved to database
- ❌ Token counts remain 0 in all saved messages

---

## 🔧 Fix Required

### Step 1: Extract Usage from Done Chunk

In `AgentService.streamAgent()`, capture the usage data when processing the done chunk:

```typescript
// Add at top of streamAgent() method
let tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

// In the stream processing loop, after handling each chunk:
for await (const next of stream) {
  // ... existing chunk processing ...
  
  // NEW: Extract usage from done chunk
  if (next.value.type === 'done' && next.value.payload?.usage) {
    const usage = next.value.payload.usage;
    tokenUsage = {
      promptTokens: usage.promptTokens || 0,
      completionTokens: usage.completionTokens || 0,
      totalTokens: usage.totalTokens || 0,
    };
    console.log(`[AgentService] Token usage: ${tokenUsage.totalTokens} total (${tokenUsage.promptTokens} prompt + ${tokenUsage.completionTokens} completion)`);
  }
  
  yield next.value;
}
```

### Step 2: Update Message Creation

Pass token usage to `createAssistantStoredMessage()`:

```typescript
// Update function signature in messagePersistence.ts
export function createAssistantStoredMessage(args: {
  chatId: string;
  model: string;
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallEvent[];
  toolResults: ToolResultEvent[];
  sequence?: Array<{ type: "text" | "tool" | "thinking"; data: any }>;
  // NEW: Add token usage
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}): StoredMessage {
  return {
    // ... existing fields ...
    model: args.model,
    // NEW: Add token fields
    prompt_tokens: args.usage?.promptTokens,
    completion_tokens: args.usage?.completionTokens,
    total_tokens: args.usage?.totalTokens,
    sync_status: 'local',
  };
}
```

### Step 3: Pass Usage When Saving

Update both calls to `createAssistantStoredMessage()` in AgentService:

```typescript
// Line ~738 - Final message save
const assistantMsg: StoredMessage = createAssistantStoredMessage({
  chatId,
  model: config.model,
  assistantText,
  thinkingText,
  toolCalls,
  toolResults,
  sequence,
  usage: tokenUsage, // NEW: Pass captured usage
});

// Line ~706 - Partial message save (before retry)
const partialMsg: StoredMessage = createAssistantStoredMessage({
  chatId,
  model: config.model,
  assistantText,
  thinkingText,
  toolCalls,
  toolResults,
  sequence,
  usage: tokenUsage, // NEW: Pass captured usage
});
```

---

## 💰 Cost Calculation (To Be Implemented)

Once we're saving token data, we can calculate costs:

### Model Pricing (as of 2026-02-20)

```typescript
const MODEL_PRICING = {
  // OpenAI GPT-5
  'gpt-5-mini': { input: 0.10, output: 0.40 },           // per 1M tokens
  'gpt-5-2-low': { input: 2.50, output: 10.00 },
  'gpt-5-2': { input: 5.00, output: 15.00 },
  'gpt-5-2-high': { input: 10.00, output: 30.00 },
  'gpt-5-2-xhigh': { input: 20.00, output: 60.00 },
  'gpt-5-2-codex': { input: 15.00, output: 45.00 },
  
  // Anthropic Claude
  'claude-haiku-4-5': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
  'claude-opus-4-5-thinking': { input: 15.00, output: 75.00 },
  
  // Google Gemini
  'gemini-2-5-flash-lite': { input: 0.15, output: 0.60 },
  'gemini-2-5-flash': { input: 0.30, output: 1.20 },
  'gemini-3-flash-preview': { input: 0.60, output: 2.40 },
  'gemini-3-pro-preview': { input: 2.50, output: 10.00 },
};

function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  
  return inputCost + outputCost;
}
```

### Usage Examples

```typescript
// Example 1: GPT-5-mini (cheap)
const cost1 = calculateCost('gpt-5-mini', 50000, 2000);
// Input: 50K tokens × $0.10/1M = $0.005
// Output: 2K tokens × $0.40/1M = $0.0008
// Total: $0.0058 (~0.6 cents)

// Example 2: Claude Opus (expensive)
const cost2 = calculateCost('claude-opus-4-6', 50000, 2000);
// Input: 50K tokens × $15/1M = $0.75
// Output: 2K tokens × $75/1M = $0.15
// Total: $0.90 (90 cents per response!)

// Example 3: Tool-heavy workflow
const cost3 = calculateCost('gpt-5-2', 120000, 5000);
// Input: 120K tokens × $5/1M = $0.60
// Output: 5K tokens × $15/1M = $0.075
// Total: $0.675 (~68 cents)
```

---

## 📊 Analytics to Build

Once we're persisting token/cost data, we can show:

### Per-Chat Analytics
- Total tokens used
- Total cost
- Average tokens per message
- Cost trend over conversation

### Per-Agent Analytics (for SubAgents)
- Total runs
- Average tokens per run
- Total cost
- Cost per successful completion
- Cost efficiency (cost/quality ratio)

### Global Analytics
- Daily/weekly/monthly spend
- Cost by model
- Cost by agent type
- Most expensive chats
- Token efficiency trends

### Optimization Insights
- "Switch to gpt-5-mini for this agent → save $X/month"
- "This agent's prompts are too long → optimize system prompt"
- "High token usage detected → consider summarization"
- "Cost spike alert: $X spent today (avg: $Y)"

---

## 🎯 Implementation Priority

### Phase 1: Fix Token Persistence (High Priority - 30 minutes)
- [ ] Extract usage from done chunk in AgentService
- [ ] Update `createAssistantStoredMessage()` signature
- [ ] Pass usage when saving messages
- [ ] Test with real agent runs
- [ ] Verify data in SQLite database

### Phase 2: Cost Calculation (Medium Priority - 1 hour)
- [ ] Create pricing constants
- [ ] Implement `calculateCost()` function
- [ ] Add cost field to StoredMessage
- [ ] Calculate and save cost with each message
- [ ] Add cost to database schema

### Phase 3: Basic Analytics (Medium Priority - 2 hours)
- [ ] Add `getChatCost(chatId)` method
- [ ] Add `getAgentCost(agentId)` method
- [ ] Add cost display to Agents page
- [ ] Add cost display to chat history
- [ ] Show cost in Settings

### Phase 4: Advanced Analytics (Low Priority - 4 hours)
- [ ] Build cost dashboard
- [ ] Add trend visualization (sparklines)
- [ ] Add optimization suggestions
- [ ] Add budget alerts
- [ ] Add cost forecasting

---

## 🔍 Verification

After implementing Phase 1, verify:

1. **Check SQLite Database:**
```bash
sqlite3 ~/Papr/data/chats.db
SELECT prompt_tokens, completion_tokens, total_tokens, model 
FROM messages 
WHERE role = 'assistant' 
ORDER BY timestamp DESC 
LIMIT 10;
```

Should see non-zero token counts.

2. **Check Console Logs:**
```
[AgentService] Token usage: 52847 total (50234 prompt + 2613 completion)
```

3. **Check Stored Messages:**
```typescript
const messages = await storageManager.loadMessages(chatId);
const lastAssistant = messages.find(m => m.role === 'assistant');
console.log({
  model: lastAssistant.model,
  tokens: lastAssistant.total_tokens,
  prompt: lastAssistant.prompt_tokens,
  completion: lastAssistant.completion_tokens,
});
```

Should show actual token counts, not undefined or 0.

---

## Summary

**Current State:**
- ✅ Capturing token data from Mastra/AI SDK
- ✅ Database schema supports tokens
- ❌ NOT extracting from done chunk
- ❌ NOT persisting to database

**Required Action:**
Implement Phase 1 (30 minutes) to fix the data pipeline.

**Future Value:**
Once implemented, enables cost tracking, optimization suggestions, and budget management.
