# Step Limit Graceful Stop

## Problem

When agents make too many tool calls (approaching 100), they can:
- Get cut off abruptly without responding
- Waste time and tokens on redundant calls
- Create poor user experience (no final response)
- Get stuck in loops without awareness

## Solution

Implement a **three-tier warning system** to gracefully stop agents before hitting the hard limit.

### Tier 1: Early Warning (Step 90+)

**When:** Agent reaches 90 tool calls  
**Action:** Inject warnings into tool results

**AI SDK Path:**
```typescript
// prepareStep adds warning message at 90+ steps
const warningMessage = {
  role: "user",
  content: `[SYSTEM NOTE: You've made ${stepNumber} tool calls out of ${maxSteps} maximum. 
            Please complete your current task and provide a final response soon. 
            Avoid unnecessary tool calls.]`,
};
```

**Pi-ai Path:**
```typescript
// Inject warning into last tool result
const warning = `\n\n[⚠️ Note: You've made ${step} tool calls out of ${maxSteps} maximum. 
                 Please wrap up and provide your response soon.]`;
```

### Tier 2: Force Stop (Step 95)

**When:** Agent reaches 95 tool calls  
**Action:** Stop accepting new tool calls, force final response

**AI SDK Path:**
```typescript
stopWhen: (stopOptions: any) => {
  const stepCount = stopOptions.steps.length;
  const FORCE_STOP = 95;
  
  if (stepCount >= FORCE_STOP) {
    console.warn(`🛑 Force stopping at step ${stepCount}`);
    return true;
  }
  return stepCount >= maxSteps;
}
```

**Pi-ai Path:**
```typescript
if (step >= STEP_FORCE_STOP_THRESHOLD) {
  // Add system instruction to force response
  context.messages.push({
    role: "user",
    content: `[SYSTEM: You've made ${step} tool calls. You MUST provide your final response now. 
              Do not make any more tool calls. Summarize your findings and respond to the user.]`,
  });
  break; // Force stop the loop
}
```

### Tier 3: Hard Limit (Step 100)

**When:** Agent somehow reaches 100 (shouldn't happen with Tier 2)  
**Action:** Absolute cutoff

## Benefits

1. ✅ **Prevents wasted tool calls** - Agent warned at 90, stopped at 95
2. ✅ **Always gets a response** - Force stop includes instruction to respond
3. ✅ **Better UX** - User doesn't see abrupt cutoff
4. ✅ **Catches loops early** - Agent has 5 steps to wrap up after warning
5. ✅ **Saves tokens** - Stops before hitting expensive limit

## Implementation Details

### Code Locations

**AI SDK Path:**
- `src/gateway/services/AgentService.ts:628-646` (stopWhen)
- `src/gateway/services/AgentService.ts:694-720` (prepareStep warning)

**Pi-ai Path:**
- `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts:426-473` (warning & force stop)

### Configuration

```typescript
const STEP_WARNING_THRESHOLD = 90;   // Start warning
const STEP_FORCE_STOP_THRESHOLD = 95; // Force stop
const maxSteps = 100;                 // Hard limit (shouldn't reach)
```

These thresholds are tuned to give the model enough notice while preventing waste.

## Example Flow

```
Step 1-89:  Normal operation
Step 90:    ⚠️ "You've made 90 calls, wrap up soon"
Step 91-94: Continue with warnings
Step 95:    🛑 Force stop + "Provide final response NOW"
           → Agent MUST respond (no more tool calls)
Step 96-100: (Should never reach - force stopped at 95)
```

## Testing

To test this behavior:
1. Create a task that might cause many tool calls
2. Watch logs for warnings at step 90
3. Verify force stop at step 95
4. Confirm agent provides final response

## Related

- **Context pressure monitoring** - Separate check for token limits
- **Timeout handling** - Separate from step limits
- **User abort** - Can still stop manually anytime
