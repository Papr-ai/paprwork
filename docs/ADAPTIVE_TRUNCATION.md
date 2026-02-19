# Final Improvements Based on User Feedback

## Your Questions

### Q1: Can't we see the exact tokens used in each previous step and base truncation on that?

**YES! Absolutely.** The `prepareStep` callback receives `steps` array with actual token usage data from previous steps.

**What we should implement:**
```typescript
prepareStep: async (stepOptions) => {
  // Get ACTUAL token usage from previous steps
  const totalPromptTokens = stepOptions.steps.reduce(
    (sum, step) => sum + (step.usage?.promptTokens ?? 0),
    0
  );
  
  // Adaptive truncation based on actual context pressure
  if (totalPromptTokens < 50000) {
    // Low pressure: keep more context
    return generous_limits;
  } else if (totalPromptTokens < 100000) {
    // Medium pressure: moderate limits
    return moderate_limits;
  } else {
    // High pressure: aggressive limits
    return aggressive_limits;
  }
}
```

### Q2: For the error, in the UI the agent response breaks.. we need to return to the agent to say it's too much tokens vs. break things

**Exactly right!** Currently when `read_file` returns an error (file too large), it breaks the UI instead of letting the agent handle it gracefully.

**What we should do:**
1. Tool returns error **to the agent** (not to UI directly)
2. Agent sees the error and tries again with better parameters
3. UI never breaks - just shows agent working through the problem

## Current Implementation Issues

### Issue 1: Static Limits (Not Adaptive)
```typescript
// ❌ Current: Fixed limits regardless of context state
if (positionFromEnd < 1) return null;  // Always unlimited
if (positionFromEnd < 3) return 8000;  // Always 8KB
```

**Should be:**
```typescript
// ✅ Better: Adaptive based on actual token usage
const pressure = calculatePressure(steps);
if (pressure === 'low') return 12000;   // Generous when we have room
if (pressure === 'high') return 4000;    // Aggressive when context is full
```

### Issue 2: Tool Errors Break UI
```typescript
// ❌ Current: Error returned, breaks streaming
return {
  success: false,
  error: "File too large: 50000 tokens..."
};
```

**Should be:**
```typescript
// ✅ Better: Error gives agent actionable guidance
return {
  success: false,
  error: "File is 50000 tokens (~200KB). This exceeds context limits.\n\n" +
         "Try one of these approaches:\n" +
         "1. read_file({ path: 'file.ts', offset: 1, limit: 100 })\n" +
         "2. bash({ command: \"head -n 50 file.ts\" })\n" +
         "3. search_files({ pattern: 'specific_function', filePattern: '*.ts' })\n" +
         "\nFile has 2000 lines total."
};
```

Then the agent can see this error and try again!

## Recommended Implementation

### Phase 1: Adaptive Truncation (High Priority)
```typescript
// File: src/gateway/services/AgentService.ts
prepareStep: async (stepOptions) => {
  // 1. Calculate actual context pressure
  const totalPromptTokens = stepOptions.steps.reduce(
    (sum, step) => sum + (step.usage?.promptTokens ?? 0),
    0
  );
  
  const THRESHOLDS = {
    low: 50000,      // <50K: generous
    medium: 100000,  // 50-100K: moderate
    high: 130000     // 100-130K: aggressive
  };
  
  // 2. Set limits based on pressure
  const getTruncationLimit = (position, pressure) => {
    if (position === 0) return null; // Always keep last result full
    
    if (pressure === 'low') {
      // Lots of room: keep more context
      if (position < 3) return 12000;  // 3K tokens
      if (position < 6) return 6000;   // 1.5K tokens
      return 3000;                      // 750 tokens
    } else if (pressure === 'medium') {
      // Getting full: moderate truncation
      if (position < 3) return 8000;   // 2K tokens
      if (position < 6) return 4000;   // 1K tokens
      return 2000;                      // 500 tokens
    } else {
      // Nearly full: aggressive truncation
      if (position < 3) return 4000;   // 1K tokens
      if (position < 6) return 2000;   // 500 tokens
      return 1000;                      // 250 tokens
    }
  };
  
  // 3. Log context state
  console.log(`[prepareStep] Step ${stepOptions.stepNumber}: ${totalPromptTokens} tokens, pressure: ${pressure}`);
}
```

### Phase 2: Graceful Tool Errors (High Priority)
```typescript
// File: src/core/tools/filesystem.ts
async function readFile(input) {
  // ... read file ...
  
  // Check token budget AFTER reading
  const contentStr = content.toString();
  const estimatedTokens = Math.ceil(contentStr.length / 4);
  const WARN_THRESHOLD = 2000;
  
  if (estimatedTokens > WARN_THRESHOLD && !offset && !limit) {
    // Return actionable error to agent (not hard failure)
    return {
      success: false,
      error: `File is ${estimatedTokens} tokens. This exceeds context limits and will be truncated.\n\n` +
        `File has ${contentStr.split('\n').length} lines.\n\n` +
        `To get useful results:\n` +
        `1. Read in chunks: read_file({ path: "${input.path}", offset: 1, limit: 100 })\n` +
        `2. Search specific content: bash({ command: "grep -A 5 'pattern' ${input.path}" })\n` +
        `3. Use search tool: search_files({ pattern: "...", filePattern: "*.ts" })`,
      type: "size_warning"
    };
  }
  
  // Return successful result (may be truncated later by prepareStep)
  return { success: true, data: { content: contentStr, ... } };
}
```

## Benefits

### Benefit 1: Context-Aware Truncation
```
At 40K tokens (low pressure):
- Last result: unlimited
- Next 2: 12KB each (3K tokens)
- Next 3: 6KB each (1.5K tokens)
Total: ~8K tokens for recent results

At 120K tokens (high pressure):
- Last result: unlimited
- Next 2: 4KB each (1K tokens)
- Next 3: 2KB each (500 tokens)
Total: ~3K tokens for recent results
```

**Result:** Automatically adapts to available context space!

### Benefit 2: Agent Self-Correction
```
User: "Read all files in src/"

Agent: [calls read_file("large-file.ts")]
Tool: Error - "File is 50K tokens. Try: read_file({ offset: 1, limit: 100 })"

Agent: [calls read_file("large-file.ts", offset: 1, limit: 100)]
Tool: Success - returns first 100 lines

Agent: "I read the first 100 lines. The file contains..."
```

**Result:** Agent learns and corrects itself, UI never breaks!

## Implementation Priority

1. **HIGH: Adaptive truncation** - Use actual token counts from steps
2. **HIGH: Graceful errors** - Return actionable errors to agent
3. **MEDIUM: Logging improvements** - Show context pressure in logs
4. **LOW: UI feedback** - Show truncation state to user

## Testing Plan

1. **Test adaptive truncation:**
   - Start conversation
   - Make 10 file reads
   - Check logs show increasing pressure and tighter limits

2. **Test graceful errors:**
   - Try to read large file
   - Verify agent gets error and retries with offset/limit
   - Verify UI doesn't break

3. **Test context efficiency:**
   - Long conversation with 20+ tool calls
   - Verify stays under 150K tokens
   - Verify no context length exceeded errors

## Files to Modify

1. `src/gateway/services/AgentService.ts` - Adaptive truncation in `prepareStep`
2. `src/core/tools/filesystem.ts` - Better error messages with guidance
3. `docs/ADAPTIVE_TRUNCATION.md` - This documentation
