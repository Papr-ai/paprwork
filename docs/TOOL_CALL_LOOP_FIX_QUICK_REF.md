# Tool Call Loop Fix - Quick Reference

## TL;DR
Fixed agents getting stuck making 40+, 100+, or unlimited tool calls by adding:
1. **Total tool call counter** (tracks all calls, not just steps)
2. **Hard limit** of 200 calls (configurable as `maxSteps * 2`)
3. **Loop detection** (warns if same tool called 5+ times in 10 calls)

## Before vs After

### Before
```
❌ Agent makes 40+ bash commands trying to find GCP instance
❌ No limit on total tool calls per conversation
❌ Step limit only controls model turns, not tool executions
❌ Hard to diagnose why agent kept going
```

### After
```
✅ Hard limit: Maximum 200 tool calls (2× maxSteps)
✅ Loop detection: Warns when stuck in repetitive pattern
✅ Clear logs: Shows "total tool calls: X" at each step
✅ Graceful stop: Injects system message to force response
```

## Key Changes

### File: `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts`

#### Added Variables
```typescript
let totalToolCalls = 0; // Track ALL tool calls
const recentToolCalls: Array<{ name: string; args: string }> = [];
const REPETITION_THRESHOLD = 5;
```

#### Added Logic
```typescript
// 1. Track total calls
totalToolCalls += toolCallsThisTurn.length;

// 2. Detect loops
if (maxRepetitions >= REPETITION_THRESHOLD) {
  console.warn(`⚠️ LOOP DETECTED: Tool repeated ${maxRepetitions} times`);
}

// 3. Enforce hard limit
if (totalToolCalls >= MAX_TOTAL_TOOL_CALLS) {
  console.error(`🛑 HARD LIMIT: ${totalToolCalls} calls exceeds maximum`);
  break; // Force stop
}

// 4. Enhanced logging
console.log(`Step ${step}: executed ${X} tools, total tool calls: ${totalToolCalls}`);
```

## Monitoring

### Check if Agent Hit Limit
```bash
# Search logs for hard limit messages
grep "HARD LIMIT" logs/*.log

# Count tool calls per conversation
grep "total tool calls:" logs/*.log | tail -20
```

### Check for Loops
```bash
# Find loop detection warnings
grep "LOOP DETECTED" logs/*.log
```

### View Tool Call Progression
```bash
# See how many tool calls each step made
grep "PiCodexToolLoop.*Step.*executed" logs/*.log
```

## Configuration

Edit constants in `PiCodexStreamWithToolLoop.ts`:

```typescript
const MAX_TOTAL_TOOL_CALLS = maxSteps * 2; // Default: 200 if maxSteps=100
const MAX_RECENT_TOOL_CALLS = 10;  // Window for loop detection
const REPETITION_THRESHOLD = 5;     // Warn at 5+ repetitions
```

## Troubleshooting

### "Agent stopped too early"
- Check logs for `🛑 HARD LIMIT` message
- Increase `MAX_TOTAL_TOOL_CALLS` multiplier (e.g., `maxSteps * 3`)
- Verify task actually requires that many tool calls

### "Agent still making too many calls"
- Verify the fix is deployed
- Check logs for `total tool calls: X` messages
- Ensure using PiCodex provider (not AI SDK)
- Check if hitting context limit instead of tool limit

### "False loop detection warnings"
- Check logs for `⚠️ LOOP DETECTED` message
- Increase `REPETITION_THRESHOLD` (e.g., from 5 to 7)
- Increase `MAX_RECENT_TOOL_CALLS` window (e.g., from 10 to 15)

## Related Issues

- Tool calls showing as "Running:" forever → Check if results are being yielded
- Bash commands timing out → Check `bash.ts` timeout (default 60s)
- Agent not stopping at step 95 → This fix addresses that
- UI not updating tool status → Check `MessageItem.tsx` status handling

## Testing Scenarios

1. ✅ **Normal usage**: Agent with 10-50 tool calls works fine
2. ✅ **Complex task**: Agent with 100-150 tool calls still works but gets warning
3. ✅ **Stuck agent**: Agent stops at 200 tool calls with clear message
4. ✅ **Loop detection**: Agent repeating same bash command 5+ times triggers warning

## Log Examples

### Normal Operation
```
[PiCodexToolLoop] Step 1: executed 1 tools, total tool calls: 1
[PiCodexToolLoop] Step 2: executed 3 tools, total tool calls: 4
[PiCodexToolLoop] Step 3: executed 1 tools, total tool calls: 5
```

### Loop Detected
```
[PiCodexToolLoop] ⚠️ LOOP DETECTED: Tool call repeated 5 times in last 10 calls.
Call: bash:{"command":"gcloud compute instances list --filter=...
```

### Hard Limit Reached
```
[PiCodexToolLoop] Step 47: executed 5 tools, total tool calls: 201
[PiCodexToolLoop] 🛑 HARD LIMIT: 201 tool calls exceeds maximum (200).
Forcing stop to prevent infinite loops.
```

---

**Quick Links**:
- [Full Documentation](./TOOL_CALL_LOOP_FIX.md)
- [PiCodex Tool Loop](../src/gateway/services/providers/PiCodexStreamWithToolLoop.ts)
- [Agent Service](../src/gateway/services/AgentService.ts)
