# Removing Noisy System Events from Amplitude

**Date:** 2026-04-07
**Decision:** Remove `paprwork_scheduler_tick` from Amplitude tracking

## The Problem

`paprwork_scheduler_tick` was firing **every 20-60 seconds** whenever the job scheduler ran, causing:

1. **Event flood** - 1,440-4,320 events per day per user (just from ticks)
2. **Dashboard noise** - Hard to see important user events
3. **Poor signal-to-noise** - System health ≠ user behavior
4. **Wasted quota** - Takes up event volume unnecessarily

## Why It Was Added

Originally added to track scheduler health and job execution patterns. However, this is **system monitoring**, not **user analytics**.

## The Fix

**Removed from tracking:**
- `src/gateway/services/JobsScheduler.ts` - Removed telemetry call
- `src/core/telemetry/events.ts` - Removed event definition

**Logs remain:**
```typescript
console.log(
  `[JobsScheduler] Tick: checked ${jobs.length}, launched ${launchedCount.value}, ` +
  `skipped: ${skippedRunning}`
);
```

## Better Alternatives

For scheduler health monitoring:
- ✅ **Console logs** - Already in place, perfect for debugging
- ✅ **`paprwork_scheduler_job_triggered`** - Tracks when jobs actually run (user-relevant)
- ✅ **`paprwork_scheduler_job_failed`** - Tracks scheduler failures (actionable)

## General Rule: What to Track

### ✅ Track These (User Behavior)
- User actions (clicked button, sent message, created job)
- Feature usage (which features used, how often)
- User journeys (onboarding → first action → retention)
- Errors that affect users (API failures, job crashes)

### ❌ Don't Track These (System Health)
- Periodic health checks (scheduler ticks, heartbeats)
- Internal system events (cache hits, queue processing)
- High-frequency background tasks
- Infrastructure monitoring

## Impact

**Before removal:**
```
Daily events per user: ~1,440 scheduler ticks + ~50 user events = 1,490 total
Signal-to-noise ratio: 3.4%
```

**After removal:**
```
Daily events per user: ~50 user events
Signal-to-noise ratio: 100%
```

**Result:** Clean analytics focused on user behavior, not system internals.

## Related Events to Review

These **should stay** because they track user-relevant job activity:
- ✅ `paprwork_job_created` - User action (created a job)
- ✅ `paprwork_job_completed` - User outcome (job finished)
- ✅ `paprwork_job_failed` - User issue (job failed, needs attention)
- ✅ `paprwork_scheduler_job_triggered` - Job actually ran (less frequent than ticks)
- ✅ `paprwork_scheduler_job_failed` - Scheduler failed to run job (actionable error)

## Key Takeaway

**Amplitude is for user analytics, not system monitoring.** If an event doesn't help you understand user behavior or measure product success, it probably doesn't belong in Amplitude.

Use logs, APM tools (Sentry, Datadog), or dedicated monitoring for system health.
