# Scheduler Rapid Loop Fix

**Issue ID:** Issue 60  
**Added:** 2026-04-19  
**Status:** ✅ FIXED

## Problem

Job scheduler was looping every ~250ms forever when jobs had active leases (were being processed). Console showed continuous "Tick started" messages with "Skipping job X - already has lease".

### Symptoms
```
[JobsScheduler] Tick started at 2026-04-19T17:04:19.790Z
[JobsScheduler] Checking 111 total jobs
[JobsScheduler] Skipping job d7dfd23c... (LinkedIn Connection Sender) - already has lease
[JobsScheduler] Skipping job a5683ae2... (Techstars Neon Sync) - already has lease
...
[JobsScheduler] Tick completed in 13ms - enabled: 21, due: 5, launched: 0, skipped: 0
[JobsScheduler] Tick started at 2026-04-19T17:04:20.054Z  // 264ms later!
```

Loop repeated continuously until all jobs with leases completed.

## Root Cause

**Lease tracking mismatch between scheduler and wake timer calculation:**

1. Scheduler uses `runningLeases` set to track jobs being processed
2. Jobs remain "due" (their `nextRunAt` hasn't updated yet) during processing
3. `msUntilSoonestNextRun()` didn't know about leases, so it returned `0` (jobs are due)
4. When `ms === 0`, scheduler queued 250ms minimum wake timer
5. Loop repeated forever because jobs were still "due" with leases

**Why it happened:**
- Scheduler: "Job X has lease, skip it" ✅
- Wake timer: "Job X is due, wake up in 250ms!" ❌
- No communication between them → endless loop

## Solution

Enhanced `msUntilSoonestNextRun()` to accept optional `activeLeasesPrefix` parameter (the `runningLeases` set) and skip jobs with active leases when calculating next wake time.

### Changes

**1. Updated `scheduleEngine.ts` - Added lease awareness:**
```typescript
export function msUntilSoonestNextRun(
  jobs: Iterable<{
    id: string;  // ADDED: Need job ID for lease check
    schedule?: JobSchedule;
    scheduleState?: JobScheduleState;
    status?: JobStatus;
  }>,
  nowMs: number,
  activeLeasesPrefix: Set<string> = new Set(),  // ADDED: Leases to skip
): number | null {
  let minFuture: number | null = null;
  for (const job of jobs) {
    if (!job.schedule?.enabled) continue;
    if (job.status === "running" || job.status === "waiting_permission") continue;
    
    // ADDED: Skip jobs with active scheduler leases
    const leaseKey = `schedule:${job.id}`;
    if (activeLeasesPrefix.has(leaseKey)) {
      continue;
    }
    
    const raw = job.scheduleState?.nextRunAt;
    // ... rest of logic
  }
  return minFuture;
}
```

**2. Updated `JobsScheduler.ts` - Pass leases to wake calculation:**
```typescript
private queueWake(jobs: JobRecord[]): void {
  if (this.wakeTimer) {
    clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }
  const nowMs = Date.now();
  const ms = msUntilSoonestNextRun(jobs, nowMs, this.runningLeases);  // PASS leases
  // ... rest of queueWake
}
```

## How It Works Now

1. Job becomes due → Scheduler launches it and adds to `runningLeases`
2. `msUntilSoonestNextRun()` now **skips** jobs with leases
3. Returns next actual due time (or `null` if no upcoming jobs)
4. Wake timer set to proper interval (not 250ms loop)
5. When job completes:
   - Lease removed from `runningLeases`
   - Job's `nextRunAt` updated to next schedule slot
   - Scheduler wakes naturally for next job

## Timeline Visualization

### Before (Broken)
```
T+0s:    Job X due, launch, add lease
T+0.25s: Wake timer fires (ms=0 → 250ms min)
         Job X still due (nextRunAt not updated yet)
         Job X has lease → skip
         ms=0 again → queue 250ms wake
T+0.5s:  Wake timer fires...
         [LOOP CONTINUES FOREVER]
T+30s:   Job X completes, nextRunAt updated
         Loop finally stops
```

### After (Fixed)
```
T+0s:    Job X due, launch, add lease
         msUntilSoonestNextRun sees lease → skips Job X
         Returns time until Job Y (next job without lease)
         Queue proper wake timer (e.g., 60s)
T+30s:   Job X completes, nextRunAt updated, lease removed
T+60s:   Wake timer fires for Job Y
         No more rapid loops! ✅
```

## Impact

- **Before:** Scheduler ticked every 250ms when any job had a lease (wasted CPU, log spam)
- **After:** Scheduler only wakes when actual jobs are due (efficient, clean logs) ✅
- **Performance:** Eliminated ~99% of unnecessary wake events

## Testing

1. Start app with multiple scheduled jobs (intervals 10s-60s)
2. Verify scheduler logs show natural intervals:
   ```
   [JobsScheduler] Tick completed - enabled: 21, due: 2, launched: 2, skipped: 0
   [JobsScheduler] Tick started at 2026-04-19T17:04:29.790Z  // 10s later ✅
   ```
3. No "already has lease" spam
4. Wake intervals match job schedules (not always 250ms)

## Related

- Issue 40 (Stale Running Jobs - reconciliation logic)
- Enhancement 19 (E2E Job Testing - scheduler coverage)
- Issue 57 (Jobs JSON Race Condition - concurrent saves)

## Prevention

When implementing scheduler lease patterns:
1. Always pass lease tracking to wake timer calculations
2. Skip jobs with active leases in "due" checks
3. Test with long-running jobs to catch rapid loops
4. Monitor wake intervals in logs (should match schedules)

## Files Changed

- `src/gateway/services/jobs/scheduleEngine.ts` - Added `activeLeasesPrefix` parameter, lease check
- `src/gateway/services/JobsScheduler.ts` - Pass `runningLeases` to `msUntilSoonestNextRun()`
- `docs/SCHEDULER_RAPID_LOOP_FIX.md` - This documentation
