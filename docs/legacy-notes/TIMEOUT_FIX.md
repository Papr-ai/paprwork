# Stream Timeout Fix

## Problem

**UI timeout**: 60 seconds  
**Backend timeout**: 5 minutes (300 seconds)

The UI was timing out before the backend could complete long-running agentic workflows.

## Error

```
[useAgent] sendMessage error: Error: Stream timeout
```

## Root Cause

```typescript:204-210:ui/src/lib/gateway.ts
// OLD: 60 second timeout
setTimeout(() => {
  if (this.handlers.has(id)) {
    this.handlers.delete(id);
    reject(new Error("Stream timeout"));
  }
}, 60000); // Only 60 seconds!
```

With complex multi-step workflows:
1. **Step 1**: Thinking (5-10s) + Tool call (5-10s) + Tool execution (5-30s) = 15-50s
2. **Step 2**: More thinking + Another tool call = another 15-50s
3. **Step 3**: Final response generation = 5-10s

**Total**: 35-110 seconds → **Exceeds 60s timeout!**

## Fix

Increased UI timeout to match backend:

```typescript:204-211:ui/src/lib/gateway.ts
// NEW: 5 minute timeout
setTimeout(() => {
  if (this.handlers.has(id)) {
    this.handlers.delete(id);
    reject(new Error("Stream timeout"));
  }
}, 5 * 60 * 1000); // 5 minutes = 300 seconds
```

## Why 5 Minutes?

**Complex workflows need time:**
- Research tasks: Multiple search + read operations
- Codebase analysis: Find files + read + analyze
- Multi-file edits: Read + modify + verify
- Debugging: Reproduce + analyze + fix

**Backend already handles this:**
```typescript:375:src/gateway/services/AgentService.ts
timeout: { totalMs: 5 * 60 * 1000 },
```

## Testing

Before fix:
```
User: "analyze this codebase and create a report"
  ↓
Agent: Thinking... Tool call 1... Tool call 2...
  ↓ 60 seconds pass
❌ Error: Stream timeout
```

After fix:
```
User: "analyze this codebase and create a report"
  ↓
Agent: Thinking... Tool call 1... Tool call 2... Tool call 3... Response
  ↓ 2-3 minutes
✅ Success: Complete report delivered
```

## Alternative Approaches Considered

### Option 1: Keep 60s, reduce backend to match
❌ **Bad**: Would break complex workflows

### Option 2: Make timeout configurable
⚠️ **Overkill**: Fixed 5min is good for 99% of use cases

### Option 3: Heartbeat mechanism
⚠️ **Complex**: Would require backend changes, adds overhead

### Option 4: Show progress to user
✅ **Good**: We already do this via streaming chunks!

## Summary

✅ **UI timeout**: 60s → 300s  
✅ **Backend timeout**: 300s (unchanged)  
✅ **User experience**: No more premature timeouts  
✅ **Safety**: Still times out after 5 minutes to prevent hangs

**The fix allows the UI to wait as long as the backend needs to complete complex workflows.**
