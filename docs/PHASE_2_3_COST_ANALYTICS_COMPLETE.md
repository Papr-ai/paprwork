# Phases 2 & 3 Complete: Cost Calculation & Analytics

**Status:** ✅ **IMPLEMENTED** - Ready for Phase 4 (UI Integration)  
**Date:** 2026-02-20

---

## Implementation Summary

We've completed **Phase 2 (Cost Calculation)** and **Phase 3 (Analytics Queries)**. The system now:

1. ✅ **Calculates costs** from token usage using model-specific pricing
2. ✅ **Stores costs** in the database alongside token counts
3. ✅ **Provides analytics** via query methods (per-chat, global stats)
4. ✅ **Type-safe** implementation (all TypeScript checks pass)
5. ✅ **Database migrated** (cost column added automatically)

---

## What Was Implemented

### Phase 2: Cost Calculation

#### 1. Created Cost Calculator (`CostCalculation.ts`)

**File:** `src/gateway/services/CostCalculation.ts`

**Features:**
- Model pricing table (USD per 1M tokens)
- Cost calculation for 16 models (GPT-5, Claude, Gemini)
- Detailed cost breakdown
- Cost formatting for display
- Savings calculator for model comparison
- Monthly cost estimation

**Example Usage:**
```typescript
import { calculateCost, formatCost } from './CostCalculation.js';

// Calculate cost
const cost = calculateCost('gpt-5-2', 50000, 2500);
// = (50K / 1M × $5) + (2.5K / 1M × $15)
// = $0.25 + $0.0375 = $0.2875

// Format for display
formatCost(0.2875); // "$0.288"
formatCost(0.005);  // "$0.005"
formatCost(5.50);   // "$5.50"
```

#### 2. Updated Database Schema

**Changes:**
- Added `cost REAL DEFAULT 0` column to messages table
- Automatic migration for existing databases
- Cost saved on every message

**Migration:**
```sql
-- Automatically runs on startup
ALTER TABLE messages ADD COLUMN cost REAL DEFAULT 0;
```

#### 3. Updated Message Persistence

**File:** `src/gateway/services/agent/messagePersistence.ts`

**Changes:**
- Calculate cost when creating messages
- Pass cost to database
- Works for both successful and error messages

**Example:**
```typescript
const cost = args.usage
  ? calculateCost(args.model, args.usage.promptTokens, args.usage.completionTokens)
  : undefined;

return {
  // ... other fields ...
  prompt_tokens: args.usage?.promptTokens,
  completion_tokens: args.usage?.completionTokens,
  total_tokens: args.usage?.totalTokens,
  cost, // ✅ NEW: USD cost
  sync_status: "local",
};
```

#### 4. Updated Storage INSERT/SELECT

**Files:**
- `LocalStorageProvider.ts`
- `IStorageProvider.ts`

**Changes:**
- INSERT includes cost field
- SELECT retrieves cost field
- StoredMessage interface includes `cost?: number`

---

### Phase 3: Analytics Queries

#### 1. Per-Chat Cost Analytics

**Method:** `getChatCost(chatId: string)`

**Returns:**
- Total cost for the chat
- Cost breakdown by model
- Number of messages
- Average cost per message

**Example:**
```typescript
const cost = await storageManager.getChatCost(chatId);
console.log({
  total: cost.total,           // $2.45
  byModel: {
    'gpt-5-2': 1.80,
    'claude-sonnet-4-6': 0.65
  },
  messageCount: 15,
  avgCostPerMessage: 0.163,    // $0.16/msg
});
```

#### 2. Global Cost Statistics

**Method:** `getGlobalCostStats()`

**Returns:**
- Today's cost
- This week's cost
- This month's cost
- Total cost (all time)
- Total messages
- Top 10 models by cost

**Example:**
```typescript
const stats = await storageManager.getGlobalCostStats();
console.log({
  today: 0.85,              // $0.85 today
  thisWeek: 5.20,           // $5.20 this week
  thisMonth: 18.75,         // $18.75 this month
  total: 127.40,            // $127.40 all time
  totalMessages: 850,
  topModels: [
    { model: 'gpt-5-2', cost: 65.30, count: 450 },
    { model: 'claude-sonnet-4-6', cost: 42.10, count: 280 },
    // ...
  ]
});
```

#### 3. Updated getChatStats

**Changes:**
- Now returns `cost_total` in addition to tokens
- Used for chat-level summaries

**Before:**
```typescript
return {
  message_count: 10,
  token_count: 50000,
  has_summary: true,
};
```

**After:**
```typescript
return {
  message_count: 10,
  token_count: 50000,
  cost_total: 0.45,  // ✅ NEW
  has_summary: true,
};
```

#### 4. Implemented for All Storage Providers

**LocalStorageProvider:**
- Full SQL-based implementation
- Fast queries with proper indexes
- Accurate cost calculations

**PaprMemoryProvider:**
- Stub implementation (returns 0s)
- PAPR doesn't provide cost data

**HybridStorageProvider:**
- Delegates to LocalStorageProvider
- Always uses local for cost queries (most accurate)

---

## Testing the Implementation

### 1. Verify Cost Calculation

```typescript
// In browser DevTools console or Electron main process
import { calculateCost, formatCost } from './src/gateway/services/CostCalculation.js';

// Test GPT-5-mini (cheapest)
console.log(formatCost(calculateCost('gpt-5-mini', 50000, 2000)));
// Expected: "$0.006" (very cheap!)

// Test GPT-5-2 (mid-range)
console.log(formatCost(calculateCost('gpt-5-2', 50000, 2000)));
// Expected: "$0.280" (28 cents)

// Test Claude Opus (expensive)
console.log(formatCost(calculateCost('claude-opus-4-6', 50000, 2000)));
// Expected: "$0.900" (90 cents!)
```

### 2. Check Database After Sending Messages

```bash
sqlite3 ~/PAPR/data/chats.db
```

```sql
-- Check recent messages with cost
SELECT 
  id,
  model,
  prompt_tokens,
  completion_tokens,
  cost,
  LENGTH(content) as content_length
FROM messages 
WHERE role = 'assistant' 
ORDER BY timestamp DESC 
LIMIT 5;
```

**Expected Output:**
```
msg-abc|gpt-5-2|50234|2613|0.288|1250
msg-def|gpt-5-mini|12500|450|0.003|380
msg-ghi|claude-sonnet-4-6|45000|3200|0.183|890
```

### 3. Test Analytics Queries

```typescript
// Get cost for a specific chat
const chatCost = await storageManager.getChatCost('your-chat-id');
console.table(chatCost);

// Get global stats
const globalStats = await storageManager.getGlobalCostStats();
console.table(globalStats);
console.table(globalStats.topModels);
```

---

## Model Pricing Reference

### OpenAI GPT-5 (per 1M tokens)
| Model | Input | Output | Use Case |
|-------|-------|--------|----------|
| gpt-5-mini | $0.10 | $0.40 | Quick tasks, high volume |
| gpt-5-2-low | $2.50 | $10.00 | Standard tasks |
| gpt-5-2 | $5.00 | $15.00 | Complex reasoning |
| gpt-5-2-high | $10.00 | $30.00 | Very complex tasks |
| gpt-5-2-xhigh | $20.00 | $60.00 | Research-grade |
| gpt-5-2-codex | $15.00 | $45.00 | Code generation |

### Anthropic Claude 4 (per 1M tokens)
| Model | Input | Output | Use Case |
|-------|-------|--------|----------|
| claude-haiku-4-5 | $0.80 | $4.00 | Fast responses |
| claude-sonnet-4-6 | $3.00 | $15.00 | Balanced quality/cost |
| claude-opus-4-6 | $15.00 | $75.00 | Highest quality |
| claude-opus-4-5-thinking | $15.00 | $75.00 | Deep reasoning |

### Google Gemini (per 1M tokens)
| Model | Input | Output | Use Case |
|-------|-------|--------|----------|
| gemini-2-5-flash-lite | $0.15 | $0.60 | Ultra-fast |
| gemini-2-5-flash | $0.30 | $1.20 | Fast & capable |
| gemini-3-flash-preview | $0.60 | $2.40 | Preview features |
| gemini-3-pro-preview | $2.50 | $10.00 | Pro features |

---

## Cost Examples

### Example 1: Quick Question (GPT-5-mini)
```
Input:  5,000 tokens  (context + question)
Output:   200 tokens  (answer)
Cost:   $0.0013  (~0.1 cent per response)

Daily:   100 questions = $0.13
Monthly: 3000 questions = $4.00 ✅ Very affordable
```

### Example 2: Research Task (GPT-5-2)
```
Input:  50,000 tokens  (research context)
Output:  2,500 tokens  (summary)
Cost:   $0.29 per response

Daily:   10 tasks = $2.90
Monthly: 300 tasks = $87 💰 Moderate cost
```

### Example 3: Code Review (Claude Opus)
```
Input:  120,000 tokens (full codebase)
Output:   5,000 tokens (detailed review)
Cost:   $2.18 per review

Daily:    5 reviews = $10.90
Monthly: 150 reviews = $327 ⚠️ Expensive!
```

### Example 4: Tool-Heavy Workflow (GPT-5-2)
```
Input:  120,000 tokens (context builds up over multiple tool calls)
Output:   5,000 tokens (responses + narration)
Cost:   $0.68 per workflow

Daily:   20 workflows = $13.60
Monthly: 600 workflows = $408 💸 Watch out!
```

---

## Optimization Insights (Coming in Phase 4)

Once we integrate this into the UI, users will see:

### 1. Model Recommendations
```
"Switch to gpt-5-mini for this agent → save $12/month"
"This agent rarely fails with gpt-5-mini (98% success rate)"
```

### 2. Cost Alerts
```
⚠️ High-cost chat detected: $5.20 (average: $0.40)
💡 Consider using gpt-5-mini for simpler tasks
```

### 3. Budget Tracking
```
📊 Monthly Spend: $18.75 / $50.00 budget (37%)
📈 Trending: +15% vs last month
```

### 4. Agent Performance
```
🤖 Research Specialist
   Cost: $24.50 (12 runs)
   Avg: $2.04/run
   Model: gpt-5-2
   💡 Switch to gpt-5-mini → save $18/month
```

---

## Next: Phase 4 (UI Integration)

Now that cost calculation and analytics are working, we can:

1. **Add WebSocket endpoints** for cost data
2. **Update AgentsView** to display costs
3. **Create cost dashboard** with trends
4. **Add optimization suggestions** based on usage patterns
5. **Implement budget alerts**

See `docs/AGENTS_PAGE_IMPROVEMENTS.md` for UI mockups and implementation details.

---

## Files Changed

### New Files
- `src/gateway/services/CostCalculation.ts` - Cost calculation utilities

### Modified Files
- `src/gateway/services/agent/messagePersistence.ts` - Calculate cost
- `src/gateway/services/storage/IStorageProvider.ts` - Add cost methods
- `src/gateway/services/storage/LocalStorageProvider.ts` - Implement queries
- `src/gateway/services/storage/PaprMemoryProvider.ts` - Add stubs
- `src/gateway/services/storage/HybridStorageProvider.ts` - Delegate to local

---

## Success Metrics

✅ Cost calculation implemented  
✅ Costs saved to database  
✅ Database migration working  
✅ Per-chat analytics available  
✅ Global analytics available  
✅ TypeScript compilation passes  
✅ All storage providers updated  
⏳ WebSocket endpoints (Phase 4)  
⏳ UI integration (Phase 4)  
⏳ Cost dashboard (Phase 4)  

---

## Ready for Phase 4!

The backend is complete. All cost data is being captured, calculated, and stored. Analytics queries are ready to power a beautiful cost dashboard in the Agents page.

**Next step:** Integrate into the UI so users can see their AI spending and get optimization suggestions! 🎉
