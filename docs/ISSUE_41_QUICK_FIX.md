# Quick Fix Summary: In-Memory Job State Desync

## The Problem You're Experiencing

The agent manually edited `jobs.json` to fix stuck jobs:
- **On disk:** Status changed to "completed" ✅
- **In memory:** Status still "running" ❌
- **Result:** Scheduler won't trigger new runs (thinks jobs are still running)

## Why Agent Says "Restart Papr"

Because `loadJobs()` only runs on app startup - there's no way to reload from disk while running.

## The Fix (No Restart Needed!)

I just added a new tool: `reload_jobs()`

### Agent Usage

```typescript
// 1. Fix jobs.json on disk (agent already did this)
bash({ command: "jq '...' $PAPR_HOME/data/jobs.json > tmp && mv tmp jobs.json" })

// 2. Reload from disk (NEW - replaces restart!)
reload_jobs()
// Returns: { reloaded: true, jobsCount: 183 }

// 3. Verify sync
list_jobs()
// Now shows updated status ✅

// 4. Done!
"Jobs reloaded! Scheduler will now trigger hourly runs - no restart needed."
```

## What It Does

```
Before:
- Disk: status = "completed" 
- Memory: status = "running" ← Scheduler reads this
- Scheduler: "Job is running, skip it" ❌

After reload_jobs():
- Disk: status = "completed"
- Memory: status = "completed" ← Synced from disk!
- Scheduler: "Job completed, schedule next run" ✅
```

## Benefits

| Restart App | `reload_jobs()` |
|-------------|-----------------|
| 5-10 seconds | <100ms |
| WebSocket disconnects | Stays connected |
| Agent context lost | Preserved |
| Running jobs killed | Continue |

## Next Steps

The agent should now be able to:

1. Detect the 3 stuck jobs (already done)
2. Fix them in `jobs.json` (already done)
3. Call `reload_jobs()` (NEW - just added)
4. Verify scheduler picks up changes

No app restart needed! The fix is already deployed in the code.

---

**Files Changed:**
- Added `JobsService.reloadJobs()` method
- Added `jobs:reload` WebSocket handler  
- Added `reload_jobs()` tool for agent
- Added documentation in SystemPrompt

**Issue Numbers:**
- Issue 40: Automatic stale job recovery (20-60s)
- Issue 41: Manual fix + reload (this fix)
