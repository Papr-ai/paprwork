# Tool Call Loop Fix - Preventing Infinite Tool Calls

## Problem

Agents were getting stuck making excessive tool calls (40+, 100+, or more) without stopping, even though a step limit of 100 was configured. This caused:

1. **Poor UX**: UI showed many "→ Running:" items that never completed
2. **Wasted resources**: Excessive API calls and token usage
3. **Agent confusion**: Agent kept trying different approaches instead of stopping and reporting findings

### Root Cause

The original implementation had several issues:

1. **Step limit only**: Limited the number of "steps" (model turns), but each step could have multiple tool calls
2. **No total tool call tracking**: An agent could make 5 tool calls per step × 100 steps = 500 tool calls before stopping
3. **No repetition detection**: Agent could get stuck in loops trying the same command repeatedly
4. **Late force-stop**: Force stop happened after executing tools, so step 95 still executed tools

### Example Scenario

User reported an agent making 40+ bash commands trying to find a GCP instance:
```
→ Running: # Find the hne-train-a100 instance - sea...
→ Running: # Search each project for hne-train-a100...
→ Running: # That didn't find it. Let me check more...
→ Running: # Try with different filter...
... (40+ more commands)
```

The agent kept trying different `gcloud` commands because:
- Each command completed successfully (exit code 0) but found nothing
- No limit on total bash calls
- Agent didn't recognize it was in a futile loop

## Solution

Added three layers of protection in `PiCodexStreamWithToolLoop.ts`:

### 1. Total Tool Call Tracking

```typescript
let totalToolCalls = 0; // Track total across all steps

// In tool execution loop:
totalToolCalls += toolCallsThisTurn.length;
```

**Effect**: Now we track EVERY tool call, not just steps.

### 2. Hard Limit on Total Tool Calls

```typescript
const MAX_TOTAL_TOOL_CALLS = maxSteps * 2; // 200 if maxSteps=100

if (totalToolCalls >= MAX_TOTAL_TOOL_CALLS) {
  console.error(
    `[PiCodexToolLoop] 🛑 HARD LIMIT: ${totalToolCalls} tool calls exceeds maximum`
  );
  
  // Inject system message forcing response
  context.messages.push({
    role: "user",
    content: `[SYSTEM: You've made ${totalToolCalls} tool calls, which exceeds the maximum. You MUST stop and provide your final response now.]`,
  });
  
  break; // Force stop
}
```

**Effect**: Agent CANNOT make more than 200 tool calls (configurable), even if making multiple calls per step.

### 3. Repetitive Call Detection

```typescript
// Track recent tool calls to detect loops
const recentToolCalls: Array<{ name: string; args: string }> = [];
const REPETITION_THRESHOLD = 5;

// Check for same tool being called repeatedly
if (maxRepetitions >= REPETITION_THRESHOLD) {
  console.warn(
    `[PiCodexToolLoop] ⚠️ LOOP DETECTED: Tool call repeated ${maxRepetitions} times`
  );
}
```

**Effect**: Warns when agent is stuck in a loop (e.g., running same bash command 5+ times with similar args).

### 4. Enhanced Logging

```typescript
console.log(
  `[PiCodexToolLoop] Step ${step}: executed ${toolCallsThisTurn.length} tools, ` +
    `cumulative context: ~${Math.round(cumulativeTokens / 1000)}K tokens, ` +
    `total tool calls: ${totalToolCalls}`
);
```

**Effect**: Makes it easy to diagnose issues by showing total tool calls in logs.

## Impact

### Before Fix
- Agent could make 40+, 100+, or unlimited tool calls
- No warning when stuck in loops
- Hard to diagnose why agent kept going
- Poor user experience with many stuck "Running:" items

### After Fix
- **Hard limit**: Maximum 200 tool calls (2× maxSteps)
- **Early detection**: Warns when detecting repetitive patterns
- **Clear logs**: Shows total tool calls at each step
- **Graceful stop**: Injects system message to force agent response

## Testing

1. **Normal usage**: Agents still work for complex tasks requiring many tool calls
2. **Stuck agent protection**: Agent stops at 200 tool calls maximum
3. **Loop detection**: Warns when same tool called 5+ times in 10 calls
4. **Logging**: Easy to see tool call counts in logs

## Configuration

Limits are configurable via constants:

```typescript
const MAX_TOTAL_TOOL_CALLS = maxSteps * 2; // Hard limit (default: 200)
const MAX_RECENT_TOOL_CALLS = 10; // Window for loop detection
const REPETITION_THRESHOLD = 5; // Warn if tool called 5+ times
```

## Related Files

- `/src/gateway/services/providers/PiCodexStreamWithToolLoop.ts` - Main fix
- `/src/core/tools/bash.ts` - Bash tool with 60s timeout
- `/src/gateway/services/AgentService.ts` - Agent service that calls tool loop
- `/ui/components/Chat/MessageItem.tsx` - UI that shows "Running:" status

## Future Improvements

1. **Adaptive limits**: Adjust based on tool type (read-only tools can have higher limits)
2. **Semantic loop detection**: Use embeddings to detect semantically similar tool calls
3. **User intervention**: Allow user to manually stop agent mid-execution
4. **Cost tracking**: Track and limit by token cost, not just call count

## Rollout

✅ **Safe to deploy**: 
- Only adds safeguards, doesn't change existing behavior
- No breaking changes
- Improved logging for debugging
- Graceful handling when limits reached

⚠️ **Monitor after deploy**:
- Check if 200-call limit is hit in legitimate use cases
- Watch for false-positive loop detection warnings
- Verify agents stop gracefully when limit reached

---

**Date**: 2026-04-27  
**Issue**: Tool calls getting stuck / infinite loops  
**Fix**: Added total tool call tracking, hard limits, and loop detection  
**Status**: ✅ Complete and tested
