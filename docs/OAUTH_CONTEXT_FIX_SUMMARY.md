# OAuth Context Length Fix - Summary

## Problem
ChatGPT and Claude OAuth routes were hitting `context_length_exceeded` errors after 10-15 tool calls with large results.

## Root Cause
The OAuth path uses `pi-ai` library instead of AI SDK. The pi-ai path had **no context management**:
- No tool result truncation
- No context pressure monitoring  
- No auto-summarization
- Tool results accumulated indefinitely in context

Meanwhile, the API key path (AI SDK) had all these features built in.

## Solution Implemented

### 1. Added Adaptive Tool Result Truncation
**File:** `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts`

```typescript
function appendToolTurnToContext(
  context: { messages: unknown[] },
  assistantMessage: {...},
  toolResults: Array<{...}>,
  cumulativeTokens: number, // NEW: Track token usage for adaptive limits
): void {
  // Apply pressure-based truncation limits
  // Low pressure (<30K): 12KB per result (3K tokens)
  // Medium pressure (30-60K): 8KB per result (2K tokens)  
  // High pressure (60-90K): 4KB per result (1K tokens)
  // Emergency: 200KB max per result (~50K tokens)
}
```

### 2. Added Context Pressure Monitoring
**File:** `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts`

```typescript
export async function* createPiCodexStreamWithToolLoop(
  // ... params
  onContextPressure?: () => Promise<void>, // NEW callback
): AsyncGenerator<OurChunk> {
  let cumulativeTokens = 0;
  const CONTEXT_ABORT_THRESHOLD = 120000;

  while (step < maxSteps) {
    // Check pressure before each step
    if (cumulativeTokens > CONTEXT_ABORT_THRESHOLD) {
      yield { type: "error", error: { type: "context_length_exceeded" } };
      if (onContextPressure) await onContextPressure();
      break;
    }
    // ... rest of loop
  }
}
```

### 3. Connected to Auto-Summarization
**File:** `src/gateway/services/AgentService.ts`

```typescript
// Pass callback to enable summarization on pressure
const onContextPressure = async () => {
  contextPressureAborted = true;
  abortController.abort();
};

fullStream = createPiCodexStreamWithToolLoop(
  streamSimple, piModel, piContext, streamOpts,
  tools, apiKeys, maxSteps,
  onContextPressure, // Enable auto-summarization
);
```

## Result

| Feature | Before | After |
|---------|--------|-------|
| Tool result truncation | ❌ None | ✅ Adaptive (12KB → 4KB based on pressure) |
| Context monitoring | ❌ None | ✅ Tracks cumulative tokens |
| Auto-summarization | ❌ None | ✅ Triggers at 120K tokens |
| Retry with summary | ❌ None | ✅ Recursive call with compressed context |
| Max single result | ❌ Unlimited | ✅ 200KB (emergency limit) |

**OAuth and API key routes now have identical context management!**

## Testing

### Before Fix
- Start chat with ChatGPT OAuth
- Run 10-15 tool calls with large results (file reads, bash commands)
- **Result:** `context_length_exceeded` error after ~10 calls

### After Fix  
- Start chat with ChatGPT OAuth
- Run 15+ tool calls with large results
- **Result:**
  - Tool results truncated adaptively based on pressure
  - At 120K tokens: "Compressing conversation history..."
  - Summary generated automatically
  - Conversation continues seamlessly
  - **NO errors!**

## Files Changed

1. `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts`
   - Added `cumulativeTokens` parameter to `appendToolTurnToContext()`
   - Added adaptive truncation logic (pressure-based limits)
   - Added context pressure monitoring to main loop
   - Added `onContextPressure` callback parameter

2. `src/gateway/services/AgentService.ts`
   - Added `onContextPressure` callback for pi-ai path
   - Connects to existing summarization flow

3. `docs/OAUTH_CONTEXT_MANAGEMENT.md` - Complete documentation
4. `CLAUDE.md` - Added Issue #10 entry

## Related Issues

- **Issue #8:** Context Length Exceeded - Tool Results Accumulating (API key path, fixed 2026-02-19)
- **Issue #10:** OAuth Context Management (OAuth path, fixed 2026-03-03)

Both fixes use the same strategy: adaptive truncation + pressure monitoring + auto-summarization.
