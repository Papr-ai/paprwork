# Step Limit Graceful Stop - Quick Ref

## Three-Tier System

| Step Range | Action | Effect |
|------------|--------|--------|
| 1-89 | Normal | Full operation |
| 90-94 | ⚠️ Warn | "Wrap up soon" injected |
| 95 | 🛑 Stop | Force response, no more tools |
| 96-100 | (Never) | Hard limit backup |

## Key Thresholds

```typescript
STEP_WARNING_THRESHOLD = 90    // Start warnings
STEP_FORCE_STOP_THRESHOLD = 95 // Force stop & respond
maxSteps = 100                 // Hard limit (backup)
```

## What Happens

**Step 90:** Warning injected in tool results  
**Step 95:** Loop breaks, system message forces response  
**Result:** Agent always responds, never hits 100

## Benefits

✅ No wasted calls (stops at 95, not 100)  
✅ Always get response (forced at 95)  
✅ Better UX (graceful vs abrupt cutoff)  
✅ Saves tokens (5 fewer calls)

## Files Modified

- `AgentService.ts` (AI SDK stopWhen + prepareStep)
- `PiCodexStreamWithToolLoop.ts` (pi-ai force stop)

## Logs to Watch

```
[prepareStep] ⚠️ Step 90/100: Approaching step limit
[AgentService] 🛑 Force stopping at step 95
[PiCodexToolLoop] 🛑 Reached 95 steps, forcing final response
```
