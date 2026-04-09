# Job Schedule Status Clarity Fix

**Date:** 2026-04-04
**Issue:** Agent confusion between "disabled schedules" and "inactive jobs"

## Problem

Agents were reporting jobs as "disabled" when they actually meant "schedule disabled", causing confusion with the Jobs UI which showed those same jobs as active and running.

### Root Cause

The `list_jobs` tool was only returning schedule information for jobs with `enabled: true`:

```typescript
// BEFORE: Only showed schedule when enabled
schedule: j.schedule?.enabled
  ? {
      cron: j.schedule.cron,
      intervalMs: j.schedule.intervalMs,
      atTime: j.schedule.atTime,
    }
  : undefined,
```

This made agents think jobs without visible schedule data were "disabled" or "broken", when in reality:
- Jobs can be **RUNNING** (currently executing)
- Jobs can be **IDLE** (available to run manually or via dependencies)
- Jobs can be **SCHEDULED** (automatic runs enabled)

### Confusion Example

**Agent said:** "These 6 jobs are disabled"
**UI showed:** 4 RUNNING, 111 IDLE, 13 SCHEDULED
**Reality:** Jobs had `schedule.enabled: false` but were still active and could run

## Solution

### 1. Show Schedule Status Always

Changed `list_jobs` to return schedule information even when disabled:

```typescript
// AFTER: Always show schedule status
schedule: j.schedule
  ? {
      enabled: j.schedule.enabled,  // ← Now explicitly shows true/false
      cron: j.schedule.cron,
      intervalMs: j.schedule.intervalMs,
      atTime: j.schedule.atTime,
    }
  : undefined,
```

Now agents see three distinct states:
- `schedule: { enabled: true, cron: "..." }` → Scheduled
- `schedule: { enabled: false }` → Disabled schedule (but job still active)
- `schedule: undefined` → Never had a schedule

### 2. Enhanced Tool Documentation

Updated `list_jobs` description:

```typescript
- See schedule status: schedule.enabled: true (scheduled), schedule.enabled: false (disabled), schedule: undefined (never scheduled)

IMPORTANT: Jobs with schedule.enabled: false are NOT deleted or broken — they can still run manually or via dependencies. They just won't run automatically on a schedule.
```

### 3. Clarified Disable Capability

Updated `update_job` description to explicitly show how to disable schedules:

```typescript
- Disable a schedule: { jobId, schedule: { enabled: false } } — job still exists but won't run automatically
```

## Impact

**Before:**
- Agent: "Job is disabled" → User confused (job is running!)
- Agent: Couldn't tell difference between disabled schedule vs deleted job
- Agent: Might try to recreate jobs that already exist but have disabled schedules

**After:**
- Agent: "Job has disabled schedule" → Accurate
- Agent: Can see `schedule.enabled: false` explicitly
- Agent: Understands job is active but not scheduled
- Agent: Can enable/disable schedules correctly with `update_job`

## Testing

### Verify Fix

```bash
# 1. Create a scheduled job
create_job({ 
  name: "Test Job",
  type: "bash",
  command: "echo 'test'",
  schedule: { enabled: true, intervalMs: 60000 }
})

# 2. List jobs - should see schedule.enabled: true
list_jobs({ status: "idle" })

# 3. Disable schedule
update_job({ 
  jobId: "...",
  schedule: { enabled: false }
})

# 4. List jobs again - should see schedule.enabled: false (not undefined)
list_jobs({ status: "idle" })

# 5. Job should still show in UI as IDLE (not DISABLED)
# 6. Job can still be run manually: run_job({ jobId: "..." })
```

## Files Changed

- `src/core/tools/appJobs.ts` - Updated `list_jobs` return format and tool descriptions

## Related

- Issue: Jobs UI vs Agent disagreement on job state
- User confusion: "Agent says disabled but UI shows running"
- Enhancement: Better schedule status visibility for agents

## Prevention

When exposing job data to agents:
1. Always show explicit boolean flags (not just omit when false)
2. Document three-state logic (true/false/undefined)
3. Clarify difference between "job disabled" vs "schedule disabled"
4. Test agent interpretation with various job states
