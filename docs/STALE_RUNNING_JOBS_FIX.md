# Stale Running Jobs Fix

**Date:** 2026-04-04
**Issue:** Jobs stuck in "running" status with no actual processes, causing UI/Agent confusion

## Problem

Jobs were showing status "running" in both the UI (4 RUNNING) and database, but:
- No actual job processes were running
- Jobs had been stuck since April 1st (3+ days ago)
- Logs showed no recent activity
- Stale detection existed but wasn't catching them

### Root Cause Analysis

1. **Jobs stuck in "running" for 93-97 hours** without actual processes
2. **Stale detection exists** (`reconcileStaleRunningJobs()`) but only called by scheduler
3. **Scheduler only runs on scheduled jobs** - if scheduler isn't actively checking a job, stale detection doesn't run on it
4. **Not called on startup** - stale detection missing from `initialize()` method
5. **Race condition**: App crash/restart can leave jobs in "running" state permanently

### Affected Jobs

```
Techstars Neon Sync (python) - stuck 93 hours
LinkedIn Connection Sender (node) - stuck 97 hours  
LinkedIn Message Sender (node) - stuck 97 hours
LinkedIn Chrome Manager (node) - stuck 97 hours
```

## Solution

### 1. Add Stale Detection to Startup

Added `reconcileStaleRunningJobs(60_000)` to `JobsService.initialize()` so stale jobs are detected on every app launch:

```typescript
async initialize(): Promise<void> {
  // ... existing init code ...
  
  // Reconcile interrupted jobs from previous session
  await this.reconcileInterruptedJobs();

  // Detect and mark stale running jobs (jobs stuck in "running" for >60s with no tracked process)
  await this.reconcileStaleRunningJobs(60_000);

  await this.reconcileScheduleStates();
  
  this.initialized = true;
}
```

**Why 60 seconds threshold on startup?**
- Normal jobs complete or fail within seconds/minutes
- 60 seconds catches legitimately stuck jobs
- Avoids false positives for jobs that just started
- Scheduler uses 20 second threshold during operation (tighter monitoring)

### 2. Created Fix Script

`scripts/fix-stale-jobs.mjs` - Immediate fix for existing stale jobs:

```bash
node scripts/fix-stale-jobs.mjs
```

The script:
- Scans all jobs for "running" status
- Checks if `lastRunAt` is >60 seconds ago
- Marks as "failed" with clear error message
- Includes how long they were stuck (e.g., "93 hours")
- Reminds user to restart app (job state cached in memory)

### 3. Detection Logic (Existing, Now Called on Startup)

```typescript
async reconcileStaleRunningJobs(minStaleMs: number = 20_000): Promise<void> {
  const processBackedTypes = ['shell', 'bash', 'node', 'python', 'swift'];
  const nowMs = Date.now();
  
  for (const [jobId, job] of this.jobs.entries()) {
    if (job.status !== 'running') continue;
    if (!processBackedTypes.includes(job.type)) continue;
    if (this.running.has(jobId)) continue; // Has tracked process
    
    const anchorMs = new Date(job.lastRunAt ?? job.updatedAt).getTime();
    if (nowMs - anchorMs < minStaleMs) continue; // Not stale yet
    
    // Mark as failed
    await this.setJobStatus(jobId, 'failed', {
      error: 'Stale running state — the worker likely finished but Paprwork did not save completion. Check logs, then run again if needed.',
      currentExecutionId: undefined,
    });
  }
}
```

## Impact

**Before:**
- 4 jobs stuck in "running" for 3+ days
- UI showed "4 RUNNING" incorrectly
- Agent confused (reported as "disabled")
- Scheduler couldn't launch new runs (skips "running" jobs)
- No automatic recovery until manual intervention

**After:**
- Stale jobs detected on every app startup (60s threshold)
- Stale jobs detected during scheduler ticks (20s threshold)
- UI shows accurate status ("failed" with clear reason)
- Agent sees correct state
- Scheduler can re-launch jobs normally
- Fix script available for immediate manual fixes

## Testing

### Verify Fix Works

```bash
# 1. Check current stale jobs
node scripts/fix-stale-jobs.mjs

# 2. Restart Paprwork to reload job state
# (Kill app, run npm start)

# 3. Verify UI shows 0 RUNNING (should show IDLE or FAILED)

# 4. Check database
cat ~/Papr/data/jobs.json | jq '[.[] | select(.status == "running")] | length'
# Should return: 0

# 5. Try running one of the fixed jobs
# list_jobs() -> find jobId -> run_job({ jobId })
```

### Simulate Stale Job (Testing)

```bash
# 1. Create test job
create_job({
  name: "Test Stale Detection",
  type: "bash",
  command: "sleep 5"
})

# 2. Manually set status to "running" and clear currentExecutionId
# (Edit ~/Papr/data/jobs.json)

# 3. Set lastRunAt to 2 minutes ago

# 4. Restart app

# 5. Check logs for "[JobsService] Stale running job"

# 6. Verify job marked as failed
```

## Prevention

### For Future Development

1. **Always call stale detection on startup** - catches jobs from crashes/restarts
2. **Use shorter thresholds for scheduled jobs** - catch issues faster (20s vs 60s)
3. **Log stale detection warnings** - makes debugging easier
4. **Track execution IDs properly** - helps identify which run got stuck
5. **Consider heartbeat mechanism** - long-running jobs ping gateway every 30s

### For Users

1. **Restart app if jobs seem stuck** - triggers stale detection
2. **Check logs before re-running** - might have completed but state not saved
3. **Run fix script if urgent** - `node scripts/fix-stale-jobs.mjs`
4. **Report if happens frequently** - might indicate deeper process management issue

## Files Changed

- `src/gateway/services/JobsService.ts` - Added stale detection to `initialize()` 
- `scripts/fix-stale-jobs.mjs` - NEW: Manual fix script for stale jobs
- `docs/STALE_RUNNING_JOBS_FIX.md` - NEW: This documentation

## Related Issues

- Issue: Jobs showing "running" but no processes exist
- Issue: Agent reporting jobs as "disabled" when they're actually stuck
- Issue: Scheduler can't launch new runs (skips "running" jobs)
- Enhancement: Better job state tracking and recovery

## Future Enhancements

1. **Heartbeat system**: Long jobs ping every 30s, marked stale if no ping
2. **Process tracking**: Store actual PIDs, check if process exists
3. **Graceful shutdown**: Better cleanup on app close/crash
4. **Admin UI**: Dashboard showing stale job warnings
5. **Telemetry**: Track stale job frequency to identify patterns
