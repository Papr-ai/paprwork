# Issue 40: Stale Running Jobs - Why It Happens & How It's Fixed

## Quick Answer

**Why:** Jobs get stuck in "running" state when the process completes but an exception prevents the status from being saved to disk.

**How it's fixed:** Automatic reconciliation now detects stale jobs within 20-60 seconds and marks them as failed, so users can retry without restarting the app.

---

## The Problem in Detail

### What Users See
```
User: "My Python job shows 'running' but it's been 5 minutes"
Agent: "The only issue is the 3 jobs are stuck as 'running' in memory. 
        You'll need to restart the Papr app (Cmd+Q then reopen)."
```

### What's Actually Happening

**Timeline of a stale job:**

```
1. Job starts → Status set to "running" ✅
2. Child process spawns (for Python/Node/Bash jobs) ✅
3. Process tracked in this.running Map ✅
4. Job completes, process exits ✅
5. this.running.delete(jobId) removes from map ✅
6. ❌ EXCEPTION or APP KILLED here ❌
7. Status save never completes
8. Job stuck as "running" in ~/Papr/data/jobs.json
9. Job NOT in this.running map (already deleted)
10. Scheduler can't run it (status = "running")
11. User can't update it (status = "running")
12. User forced to restart app
```

### Why It Affects ALL Job Types

#### Python/Node/Bash/Shell/Swift Jobs
- Use child processes
- Process completes → `running.delete()` → status save
- Exception between steps 5-6 leaves job stuck

#### Agent/Subagent Jobs (Your Case!)
- **Don't use child processes at all**
- Never added to `this.running` map
- Any exception during execution leaves them stuck
- **Previously never checked for staleness** (skipped by type filter)

---

## The Root Cause

### Code Path

```typescript
// JobsService.ts line 899-905
proc.on("close", (code: number | null) => {
  this.running.delete(job.id);  // ← Happens FIRST
  const exitCode = code ?? -1;
  void appendRunLog(`Process exited with code ${exitCode}`);
  resolve({ exitCode, lastOutput });  // ← Promise resolves
});
// Status save happens AFTER promise resolves
// If exception occurs here, job stays "running"
```

### Why Reconciliation Didn't Work Before

```typescript
// OLD CODE (before fix)
async reconcileStaleRunningJobs(): Promise<void> {
  for (const job of this.jobs.values()) {
    if (job.status !== "running") continue;
    
    // ❌ Agent jobs skipped entirely!
    if (!processBackedTypes.includes(job.type)) continue;
    
    // ❌ Only checks process-backed jobs
    if (this.running.has(jobId)) continue;
    
    // Mark as stale...
  }
}
```

**Problems:**
1. Agent/subagent jobs **never checked** (line 4 skips them)
2. Only ran every 60 seconds (scheduler backup timer)
3. If no scheduled jobs, might not run for minutes

---

## The Fix

### What Changed

```typescript
// NEW CODE (after fix)
async reconcileStaleRunningJobs(minStaleMs: number = 20_000): Promise<void> {
  for (const job of this.jobs.values()) {
    if (job.status !== "running") continue;
    
    const staleTime = Date.now() - new Date(job.lastRunAt ?? job.updatedAt).getTime();
    if (staleTime < minStaleMs) continue;
    
    // ✅ Process-backed jobs
    if (processBackedTypes.includes(job.type)) {
      if (this.running.has(jobId)) continue;  // Still running
      await this.setJobStatus(jobId, "failed", {
        error: "Stale running state — worker finished but completion not saved"
      });
    }
    
    // ✅ Agent/subagent jobs (NOW CHECKED!)
    if (job.type === "agent" || job.type === "subagent") {
      await this.setJobStatus(jobId, "failed", {
        error: "Agent job stuck in running state"
      });
    }
  }
}
```

### When It Runs

| Trigger | Frequency | Threshold | Why |
|---------|-----------|-----------|-----|
| **App startup** | Once | 30s | Clear jobs from crashed previous session |
| **Scheduler tick** | Every 20-60s | 20s | Continuous monitoring |
| **Before scheduled run** | On-demand | 20s | Prevent conflicts |

---

## Results

### Before Fix
```
Timeline:
0:00 - Job completes but stays "running"
0:20 - User notices, asks agent
1:00 - Scheduler tick (might not run if no scheduled jobs)
5:00 - User still waiting
∞ - User restarts app manually
```

**User action required:** Cmd+Q → Reopen app

### After Fix
```
Timeline:
0:00 - Job completes but stays "running"
0:20 - reconcileStaleRunningJobs() detects and fixes
0:20 - Job marked as failed with clear error
0:21 - User clicks "Run" to retry
```

**User action required:** Click "Run" button

---

## Why Your Python Jobs Were Affected

Your case involved **3 Python jobs** stuck in running state. Here's why:

### Scenario 1: Exception During Status Save
```python
# Python job completes successfully
exit(0)

# In Node.js:
proc.on("close", (code) => {
  this.running.delete(jobId);  // ✅ Removed from map
  resolve({ exitCode: 0 });    // ✅ Promise resolves
});

// Later in runJobWithDependencies:
await this.setJobStatus(jobId, "completed", { ... });  // ❌ Exception here!
// Status never saved to disk
// Job stuck as "running"
```

### Scenario 2: App Shutdown
```
0:00 - 3 Python jobs running
0:05 - User quits app (Cmd+Q)
0:05 - Jobs killed mid-execution
0:05 - Status still "running" on disk
--- App closed ---
0:10 - User reopens app
0:10 - reconcileInterruptedJobs() should have fixed them
0:10 - But they stayed "running" in memory
```

**Why they stayed stuck:**
- Before fix: Agent jobs checked, but reconciliation only every 60s
- No scheduled jobs → scheduler didn't tick → no reconciliation
- Jobs stayed stuck until app restart

---

## Testing

### Verify the Fix Works

```bash
# 1. Create a Python job
create_job({
  name: "Test Stale",
  type: "python",
  command: "python3 -c 'import time; time.sleep(5)'"
})

# 2. Run it
run_job("job-id")

# 3. Kill the process manually (simulate crash)
# Find PID in job logs, then:
kill -9 <pid>

# 4. Wait 20-30 seconds

# 5. Check job status
get_job("job-id")
# Should show: status: "failed", error: "Stale running state..."
```

### Check Reconciliation Logs

```bash
# In terminal running the app, you'll see:
[JobsScheduler] Tick started at 2026-04-06T...
[JobsService] Stale running job abc123 (no tracked process since 2026-04-06T...); marking failed
[JobsScheduler] Tick completed in 523ms
```

---

## Prevention

While reconciliation **fixes** stale jobs, we should also **reduce** how often they occur:

### Current Safeguards ✅
1. Process completion → immediate `running.delete()`
2. Status updates wrapped in try-catch
3. Graceful shutdown stops jobs cleanly

### Future Improvements 🔜
1. **Heartbeat system** - Jobs report progress every 10s
2. **Transaction log** - Write-ahead log for status changes
3. **Process monitoring** - Track PIDs, verify they're alive
4. **Timeout enforcement** - Hard 30-minute max per job

---

## Related Documentation

- `docs/STALE_RUNNING_JOBS_FIX.md` - Complete technical documentation
- `CLAUDE.md` - Issue 40 entry with full context
- `tests/jobs-stale-reconcile.test.ts` - Automated test coverage

---

## Summary

**The agent was right** - jobs were stuck in memory. But now:

1. ✅ **Automatic detection** - All job types checked (including agent jobs)
2. ✅ **Fast recovery** - 20-60 seconds instead of infinite
3. ✅ **No restart needed** - Just click "Run" to retry
4. ✅ **Clear errors** - Users know what happened

**Your 3 Python jobs won't get stuck anymore** - if they do, they'll automatically recover within a minute.
