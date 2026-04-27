# Actual Context Token Tracking Fix

## Problem

The summarization threshold was only checking **historical message tokens** from the database, not the **actual context size** being sent to the LLM.

### Token Count Discrepancy

```
Database token_count: 14,052 tokens    ← Only message tokens
Actual LLM context:  102,000 tokens    ← Including all overhead
```

The difference (~88K tokens) comes from:
- System prompts and rules
- Tool definitions (MCP tools, papr tools, etc.)
- Attached files and terminal output
- Git status
- Open/recently viewed files metadata
- Agent transcripts info
- MCP server listings

### Why This Matters

The old threshold (50K message tokens) would never trigger if you had:
- Short messages but lots of overhead → Never summarize even at 100K context
- Long messages but little overhead → Summarize too early

## Solution

Track the **actual prompt tokens** sent to the LLM, not just historical message tokens.

### Changes Made

#### 1. AgentService.ts (lines ~1356-1382)
Use actual context tokens from the LLM's usage report:
```typescript
// For AI SDK path, use cumulativePromptTokens (tracked via onStepFinish)
// For pi-ai path, use tokenUsage.promptTokens (extracted from done chunk)
const actualContextTokens = cumulativePromptTokens || tokenUsage?.promptTokens || 0;
const messageTokens = stats.token_count;

const SUMMARIZATION_THRESHOLD = 60000;

if (actualContextTokens > SUMMARIZATION_THRESHOLD) {
  console.log(`🔄 Context size (${actualContextTokens}) > ${SUMMARIZATION_THRESHOLD} threshold - triggering summarization`);
  this.triggerSummarization(chatId).catch(console.error);
}
```

#### 2. PiCodexStreamWithToolLoop.ts (lines ~460-520)
Pass token usage from pi-ai through to AgentService:
- Modified `adaptPiStreamToAISDKEvent` to accept `cumulativeTokens` parameter
- Extract `usage.input_tokens` and `usage.output_tokens` from pi-ai done event
- Include usage in the finish chunk: `{ type: "finish", finishReason, usage: { promptTokens, completionTokens, totalTokens } }`
- Updated OurChunk type to include optional usage field

#### 3. streamOrchestrator.ts (lines ~596-618)
Extract and yield token usage from finish chunks:
```typescript
case "finish": {
  const finishChunk = rawChunk as any;
  const usage = finishChunk.usage;
  
  // Yield token usage as step-usage chunk for AgentService
  if (usage?.promptTokens) {
    console.log(
      `💰 Token usage from model: ${usage.totalTokens} total ` +
      `(${usage.promptTokens} prompt + ${usage.completionTokens} completion)`,
    );
    yield createChatStreamChunk("step-usage", { usage }, chatId);
  }
  break;
}
```

### How It Works Now

**AI SDK Path (Gemini, etc.):**
1. `onStepFinish` callback receives `step.usage.inputTokens`
2. Updates `cumulativePromptTokens` with actual input tokens
3. AgentService uses this for summarization check

**Pi-ai Path (ChatGPT OAuth, Claude OAuth):**
1. Pi-ai returns `usage.input_tokens` in done event
2. `PiCodexStreamWithToolLoop` tracks it in `cumulativeTokens`
3. Passes it through `adaptPiStreamToAISDKEvent` → finish chunk with usage
4. `orchestrateModelStream` yields step-usage chunk
5. AgentService extracts `tokenUsage.promptTokens`
6. Uses this for summarization check

### Updated Threshold

- Old: 50K message tokens (too low, wrong metric)
- New: 60K actual context tokens (includes all overhead)

### Better Logging

```
[AgentService] 📊 Chat stats after stream:
  Messages in DB: 581, has_summary: true
  Message tokens (DB): 14052        ← Historical messages
  Actual context tokens: 95000      ← What LLM actually saw
  Context overhead: 80948 tokens    ← System + tools + attachments
```

## Benefits

1. ✅ Accurate context pressure monitoring for both AI SDK and pi-ai paths
2. ✅ Trigger summarization based on real context size (not DB counts)
3. ✅ Prevents hitting model context limits unexpectedly
4. ✅ Better visibility into context overhead vs. message content
5. ✅ Works consistently for OAuth and API key flows

## Backward Compatibility

- Still shows message token count from DB for comparison
- Gracefully falls back to 0 if no token usage available
- Doesn't break existing summarization logic
- More conservative threshold (60K vs 50K) reduces false triggers
