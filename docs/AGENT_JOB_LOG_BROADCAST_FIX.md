# Agent Job Log Broadcast Fix

**Date**: 2026-02-19  
**Status**: ✅ FIXED

## Problem

Structured agent activity logs (thinking, tool calls, results) were being written to job log files but **not appearing in the UI**. 

- Server logs showed: `[AgentService] Received chunk type: reasoning-delta`, `tool-call`, etc.
- Job log files showed: `💭 Thinking: ...`, `🔧 Tool: bash`, etc.
- **UI showed**: Nothing (blank logs section in `JobStatusCard` and `DelegationCard`)

## Root Cause

`JobsService.appendLog()` was **only writing to the file** and not broadcasting to WebSocket clients:

```typescript
// BEFORE (line 382-386)
private async appendLog(jobId: string, line: string): Promise<void> {
  const logPath = this.getJobLogPath(jobId);
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  await fs.appendFile(logPath, stamped, "utf8");
  // ❌ Missing: broadcast to UI!
}
```

`JobsService.broadcastJobLogLine()` existed (line 440) but was never called by `appendLog()`.

## Fix

Modified `appendLog` to call `broadcastJobLogLine` after writing to the file:

```typescript
// AFTER (line 382-389)
private async appendLog(jobId: string, line: string): Promise<void> {
  const logPath = this.getJobLogPath(jobId);
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  await fs.appendFile(logPath, stamped, "utf8");
  
  // ✅ Broadcast log line to UI for real-time streaming
  this.broadcastJobLogLine(jobId, line);
}
```

## Impact

Now **all logs** written via `appendLog()` are broadcast to the UI in real-time via `jobs:log-line` WebSocket events.

This affects:
- **Agent jobs**: Structured activity logs (thinking, tool calls, results) from `AgentService.runIsolatedJobSession()`
- **Sub-agent delegations**: Activity logs shown in `DelegationCard`
- **Any future job type** that uses `appendLog` via the executor's `params.appendLog` callback

## Files Changed

- `src/gateway/services/JobsService.ts` - Added broadcast call to `appendLog()`

## Testing

1. Create an agent job or delegate a task
2. Open the UI and view the job/delegation card
3. Verify logs appear in real-time as the agent thinks, calls tools, and receives results
4. Check server logs (`npm start` terminal) to confirm chunks are being received
5. Check job log file (`~/papr-jobs/{jobId}/logs/job.log`) to confirm logs are persisted

## Expected Behavior

**Agent Job Card**:
```
💭 Thinking: I need to fetch the repository data...
🔧 Tool: bash
   Command: gh repo view paprwork-v2 --json name,description
✅ Result: { "name": "paprwork-v2", ... }
💭 Thinking: Now I'll analyze the data...
```

**Delegation Card**:
```
💭 Thinking: I'll search for the implementation...
🔧 Tool: semantic_search
   Query: "How are job logs broadcast to UI?"
✅ Result: Found 3 matches...
```

## Why This Works

- `appendLog` is the **single source of truth** for job logging
- All executors use `params.appendLog` (which is `JobsService.appendLog`)
- `broadcastJobLogLine` sends a `jobs:log-line` WebSocket event
- `jobLiveLogsStore.ts` subscribes to `jobs:log-line` and appends to `logsByJobId`
- `JobStatusCard` and `DelegationCard` read from `jobLiveLogsStore` and display logs
- **Result**: File persistence + real-time UI streaming in one place

## Related Docs

- `docs/JOB_CARD_WAITING_FOR_OUTPUT.md` - Why "Waiting for output..." shows before logs
- `docs/DELEGATION_CARD_LIVE_LOGS.md` - How delegation cards display sub-agent activity
- `docs/AGENT_JOB_STRUCTURED_LOGS.md` - How agent activity is captured and logged
