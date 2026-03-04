# OAuth Context Management Fix

**Date:** 2026-03-03  
**Issue:** ChatGPT/Claude OAuth routes hit context length exceeded errors  
**Root Cause:** Pi-ai OAuth path lacked context truncation and summarization  

---

## Problem

When using ChatGPT/Claude via OAuth (subscription APIs), users encountered:

```
Codex error: {"type":"error","error":{"type":"invalid_request_error",
"code":"context_length_exceeded","message":"Your input exceeds the 
context window of this model. Please adjust your input and try again.",
"param":"input"},"sequence_number":2}
```

**Why it happened:**
- OAuth routes use `pi-ai` library (`PiCodexStreamWithToolLoop.ts`) instead of AI SDK
- AI SDK path had adaptive truncation (`prepareStep`) and context monitoring (`onStepFinish`)
- Pi-ai path had NO truncation - tool results accumulated indefinitely
- After 10-15 tool calls with large results, context window was exceeded

---

## Solution

Added **three-layer context management** to pi-ai OAuth path:

### 1. Adaptive Tool Result Truncation

**File:** `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts`

```typescript
function appendToolTurnToContext(
  context: { messages: unknown[] },
  assistantMessage: {...},
  toolResults: Array<{...}>,
  cumulativeTokens: number, // NEW: Track token usage
): void {
  // Adaptive truncation based on context pressure
  const CONTEXT_PRESSURE_THRESHOLDS = {
    low: 30000,    // <30K: generous limits (12KB per result)
    medium: 60000, // 30-60K: moderate limits (8KB per result)
    high: 90000,   // 60-90K: aggressive limits (4KB per result)
  };

  // Emergency truncation: 200KB max per result (~50K tokens)
  const EMERGENCY_LIMIT = 200000;

  // Apply truncation to each tool result before adding to context
  if (text.length > EMERGENCY_LIMIT) {
    text = text.substring(0, EMERGENCY_LIMIT) + "[TRUNCATED...]";
  } else if (text.length > maxLength) {
    text = text.substring(0, maxLength) + "[TRUNCATED...]";
  }
}
```

### 2. Context Pressure Monitoring

**File:** `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts`

```typescript
export async function* createPiCodexStreamWithToolLoop(
  // ... params
  onContextPressure?: () => Promise<void>, // NEW: Callback to trigger summarization
): AsyncGenerator<OurChunk> {
  let cumulativeTokens = 0;
  const CONTEXT_ABORT_THRESHOLD = 120000; // Same as AI SDK path

  while (step < maxSteps) {
    // Check context pressure before each step
    if (cumulativeTokens > CONTEXT_ABORT_THRESHOLD) {
      console.warn(
        `[PiCodexToolLoop] Context pressure at step ${step}: ` +
        `${cumulativeTokens} tokens > ${CONTEXT_ABORT_THRESHOLD} threshold.`
      );

      // Yield error to trigger summarization
      yield {
        type: "error",
        error: {
          type: "context_length_exceeded",
          message: "Context limit approaching. Conversation will be summarized automatically.",
        },
      };

      // Trigger summarization callback
      if (onContextPressure) {
        await onContextPressure();
      }

      break; // Parent will handle retry with compressed context
    }

    // ... rest of loop
  }
}
```

### 3. Auto-Summarization and Retry

**File:** `src/gateway/services/AgentService.ts`

```typescript
// Pass context pressure callback to pi-ai path
const onContextPressure = async () => {
  console.log(`🔄 Pi-ai context pressure detected for chat ${chatId}`);
  contextPressureAborted = true;
  abortController.abort();
};

fullStream = createPiCodexStreamWithToolLoop(
  streamSimple,
  piModel,
  piContext,
  streamOpts,
  tools,
  apiKeys,
  maxSteps,
  onContextPressure, // Enable summarization on pressure
);

// Later in stream loop...
if (contextPressureAborted) {
  // 1. Yield compression start chunk
  yield { type: "compression-start", ... };

  // 2. Trigger summarization
  await this.triggerSummarization(chatId);

  // 3. Save partial message
  await this.storageManager.saveMessage(chatId, partialMsg);

  // 4. Retry with compressed context (recursive call)
  for await (const chunk of this.streamAgent(chatId, userMessage, config, options)) {
    yield chunk;
  }

  return; // Exit after retry completes
}
```

---

## Architecture Comparison

| Feature | AI SDK Path (API Keys) | Pi-ai Path (OAuth) |
|---------|------------------------|-------------------|
| **Context Truncation** | ✅ `prepareStep` | ✅ `appendToolTurnToContext` (NEW) |
| **Pressure Monitoring** | ✅ `onStepFinish` | ✅ `createPiCodexStreamWithToolLoop` (NEW) |
| **Auto-Summarization** | ✅ 120K threshold | ✅ 120K threshold (NEW) |
| **Retry with Summary** | ✅ Recursive call | ✅ Recursive call (NEW) |

**Both paths now have identical context management!**

---

## Testing

### Before Fix
```bash
# Start chat with ChatGPT OAuth
# Run 15+ tool calls with large results (file reads, bash output)
# Result: context_length_exceeded error after ~10 calls
```

### After Fix
```bash
# Start chat with ChatGPT OAuth
# Run 15+ tool calls with large results
# Result: 
# - Tool results truncated adaptively
# - At 120K tokens: "Compressing conversation history..."
# - Summary generated
# - Conversation continues with compressed context
# - NO errors!
```

---

## Benefits

1. **Consistent behavior**: OAuth and API key routes now behave identically
2. **No manual intervention**: Summarization triggers automatically at 120K tokens
3. **Graceful degradation**: Adaptive truncation prevents sudden failures
4. **Context preservation**: Summaries maintain conversation continuity
5. **Cost efficiency**: Truncated results reduce token usage

---

## Relevant Files

- `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts` - Tool loop with truncation
- `src/gateway/services/AgentService.ts` - Context pressure callback
- `src/gateway/services/agent/streamOrchestrator.ts` - Error handling
- `src/gateway/services/StorageManager.ts` - Summarization triggers

---

## Related Issues

- **Issue #8:** Context Length Exceeded - Tool Results Accumulating (API key path, fixed 2026-02-19)
- **Issue #10:** OAuth Context Management (OAuth path, fixed 2026-03-03)

Both fixes use the same strategy: adaptive truncation + pressure monitoring + auto-summarization.
