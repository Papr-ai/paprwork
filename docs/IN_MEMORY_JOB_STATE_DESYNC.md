# Issue 41: In-Memory Job State Desync After Manual Edits

**Added:** 2026-04-06
**Problem:** Agent manually fixes job status in `jobs.json` on disk, but in-memory state stays stale, preventing scheduler from running jobs
**Solution:** Added `reload_jobs()` tool to refresh in-memory state without app restart

---

## The Problem

### What Happened

```
User: "Jobs stuck in running status"
Agent: [Manually edits $PAPR_HOME/data/jobs.json]
Agent: Changed status from "running" to "completed" on disk ✅
Agent: "The real problem was: jobs stuck in 'running' status. 
       The Papr scheduler wouldn't trigger new runs because it thought 
       they were already running. I fixed the on-disk status in jobs.json, 
       but the in-memory scheduler still has the stale state."
Agent: "What you need to do: Restart Papr (Cmd+Q → reopen)"
```

### Root Cause

Paprwork has **two** sources of truth for job state:

1. **Disk:** `$PAPR_HOME/data/jobs.json` (persistent storage)
2. **Memory:** `JobsService.jobs` Map (runtime state)

**Timeline:**
```
1. Jobs stuck in "running" status (disk + memory)
2. Agent edits jobs.json directly via bash:
   bash({ command: "jq '...' $PAPR_HOME/data/jobs.json > tmp && mv tmp jobs.json" })
3. Disk now shows "completed" ✅
4. Memory still shows "running" ❌
5. Scheduler checks memory, sees "running", skips job
6. New runs never trigger
7. User forced to restart app
```

### Why Memory Doesn't Auto-Sync

```typescript
// JobsService.ts
private async loadJobs(): Promise<void> {
  const raw = await fs.readFile(this.jobsIndexPath, "utf8");
  this.jobs = new Map(jobs.map((job) => [job.id, job]));
}

async initialize(): Promise<void> {
  await this.loadJobs();  // ← Only runs on app startup!
  // ...
}
```

**The issue:** `loadJobs()` only runs during `initialize()`, which only happens once at app startup. There's no file watcher, no auto-reload, no sync mechanism.

---

## The Fix

### New Tool: `reload_jobs()`

```typescript
export const reloadJobsTool = createTool({
  id: "reload_jobs",
  description: `Reload all jobs from disk, picking up any manual edits made to $PAPR_HOME/data/jobs.json.

Use this when:
- You manually edited jobs.json to fix job status
- The in-memory scheduler state is stale
- You want to sync the running app with disk changes without restarting`,
  inputSchema: z.object({}),
  execute: async () => {
    // Reloads jobs.json from disk
    // Updates JobsService.jobs Map
    // Triggers scheduler to reschedule
  },
});
```

### New Method: `JobsService.reloadJobs()`

```typescript
// src/gateway/services/JobsService.ts
async reloadJobs(): Promise<void> {
  console.log("[JobsService] Reloading jobs from disk...");
  await this.loadJobs();  // Re-read from disk
  console.log(`[JobsService] Reloaded ${this.jobs.size} jobs from disk`);
  
  // Request scheduler to reschedule (recalculate next run times)
  void import("./JobsScheduler.js")
    .then(({ getJobsScheduler }) => {
      getJobsScheduler().requestReschedule();
    })
    .catch(() => {});
}
```

### New WebSocket Handler: `jobs:reload`

```typescript
// src/gateway/websocket/jobs.ts
case "jobs:reload": {
  await jobsService.reloadJobs();
  const jobs = await jobsService.listJobs();
  sendResponse(ws, {
    id: message.id,
    success: true,
    data: { reloaded: true, count: jobs.length },
  });
  break;
}
```

---

## Usage

### Agent Workflow (Before Fix)

```typescript
// 1. Fix status on disk
bash({ 
  command: "jq '.[] | if .id == \"abc\" then .status = \"completed\" else . end' jobs.json > tmp && mv tmp jobs.json" 
})

// 2. Memory still stale
list_jobs()
// Returns: { id: "abc", status: "running" } ← Wrong!

// 3. Tell user to restart
"Restart Papr (Cmd+Q → reopen) to pick up the changes"
```

### Agent Workflow (After Fix)

```typescript
// 1. Fix status on disk
bash({ 
  command: "jq '.[] | if .id == \"abc\" then .status = \"completed\" else . end' jobs.json > tmp && mv tmp jobs.json" 
})

// 2. Reload from disk
reload_jobs()
// Returns: { reloaded: true, jobsCount: 127 }

// 3. Verify sync
list_jobs()
// Returns: { id: "abc", status: "completed" } ← Correct!

// 4. Job runs normally
"Jobs reloaded! Scheduler will now trigger hourly runs."
```

---

## When to Use

### Use `reload_jobs()` when:

1. **Manual status fixes** - You edited jobs.json to fix stuck jobs
2. **Schedule changes** - You manually updated `schedule` or `scheduleState` fields
3. **After bulk edits** - You used jq/sed to modify multiple jobs at once
4. **Testing** - You want to inject specific job states for testing

### Don't use `reload_jobs()` for:

1. **Normal job updates** - Use `update_job()` instead (syncs memory + disk automatically)
2. **Creating jobs** - Use `create_job()` (adds to memory + disk automatically)
3. **Running jobs** - Use `run_job()` (updates status in memory + disk)
4. **File changes** - Job code changes (Python/Node scripts) don't need reload

**Rule:** Only reload when you **manually edited the jobs.json file directly** via bash/filesystem tools.

---

## Technical Details

### What Gets Reloaded

```typescript
// Before reload (stale memory)
JobsService.jobs = Map {
  "abc" => { id: "abc", status: "running", lastRunAt: "...", scheduleState: { nextRunAt: "..." } }
}

// After reload (synced with disk)
JobsService.jobs = Map {
  "abc" => { id: "abc", status: "completed", lastRunAt: "...", scheduleState: { nextRunAt: "..." } }
}

// Scheduler reschedules
JobsScheduler.requestReschedule() 
// → Triggers tick()
// → Reads JobsService.jobs
// → Sees "completed" status
// → Calculates next run time
// → Schedules wake timer
```

### Why It's Better Than Restart

| Metric | Restart App | `reload_jobs()` |
|--------|-------------|-----------------|
| **Time** | 5-10s | <100ms |
| **WebSocket** | Disconnects, reconnects | Stays connected |
| **Active chats** | Cleared | Preserved |
| **Agent context** | Lost | Preserved |
| **Running jobs** | Killed | Continue running |
| **User impact** | High (visible restart) | Low (instant sync) |

---

## Related Issues

### Issue 40: Stale Running Jobs - Automatic Reconciliation
**Problem:** Jobs get stuck in "running" status due to process completion race conditions.
**Solution:** Automatic detection and recovery within 20-60 seconds.
**Difference:** 
- Issue 40: **System** automatically fixes stale jobs
- Issue 41: **Agent** manually fixes jobs, then reloads

**Combined workflow:**
1. Issue 40 detects and marks job as "failed" (automatic)
2. Agent investigates, realizes job actually completed
3. Agent edits jobs.json to set status = "completed"
4. Agent calls `reload_jobs()` to sync memory (Issue 41 fix)

---

## Files Changed

### Core Changes
- `src/gateway/services/JobsService.ts` - Added `reloadJobs()` method
- `src/gateway/websocket/jobs.ts` - Added `jobs:reload` WebSocket handler
- `src/core/tools/appJobs.ts` - Added `reloadJobsTool` + export
- `src/core/agents/SystemPrompt.ts` - Added reload_jobs documentation

### Documentation
- `docs/IN_MEMORY_JOB_STATE_DESYNC.md` (this file)
- `CLAUDE.md` - Added Issue 41 entry

---

## Testing

### Manual Test

```typescript
// 1. Create a job
create_job({ name: "Test Job", type: "bash", command: "echo 'test'" })
// Returns: { id: "test-123", status: "pending" }

// 2. Check in-memory state
list_jobs()
// Returns: [{ id: "test-123", status: "pending" }]

// 3. Manually edit jobs.json
bash({ 
  command: `jq '.[] | if .id == "test-123" then .status = "completed" else . end' $PAPR_HOME/data/jobs.json > /tmp/jobs.json && mv /tmp/jobs.json $PAPR_HOME/data/jobs.json`
})

// 4. Check in-memory (still stale)
list_jobs()
// Returns: [{ id: "test-123", status: "pending" }] ← Still wrong!

// 5. Reload from disk
reload_jobs()
// Returns: { reloaded: true, jobsCount: 1 }

// 6. Verify sync
list_jobs()
// Returns: [{ id: "test-123", status: "completed" }] ← Fixed!
```

### Automated Test

```bash
# Start app
npm start

# In another terminal, test reload via WebSocket
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:18789');
ws.on('open', () => {
  ws.send(JSON.stringify({ 
    type: 'jobs:reload',
    id: 'test-1',
    payload: {}
  }));
});
ws.on('message', (data) => {
  console.log('Response:', data.toString());
  process.exit(0);
});
"
```

---

## Future Improvements

### 1. Auto-Reload on File Change (File Watcher)

```typescript
import { watch } from 'fs';

async initialize(): Promise<void> {
  await this.loadJobs();
  
  // Watch jobs.json for external changes
  watch(this.jobsIndexPath, async (eventType) => {
    if (eventType === 'change') {
      console.log('[JobsService] jobs.json changed externally, reloading...');
      await this.reloadJobs();
    }
  });
}
```

**Pros:** Automatic sync, no tool needed
**Cons:** Race conditions with concurrent writes, hard to debug

### 2. Transaction Log (Event Sourcing)

```typescript
// All job mutations append to transaction log
await fs.appendFile('$PAPR_HOME/data/jobs-log.jsonl', JSON.stringify({
  timestamp: new Date().toISOString(),
  operation: 'update',
  jobId: 'abc',
  changes: { status: 'completed' }
}) + '\n');

// On startup/reload, replay log to rebuild state
async reloadJobs(): Promise<void> {
  const snapshot = await this.loadJobsSnapshot();
  const log = await this.loadTransactionLog();
  this.jobs = applyLog(snapshot, log);
}
```

**Pros:** Complete audit trail, time-travel debugging
**Cons:** More complex, requires log compaction

### 3. WebSocket Broadcast on External Edit

```typescript
// JobsService detects external edit
async reloadJobs(): Promise<void> {
  await this.loadJobs();
  
  // Broadcast to all connected clients
  broadcast({
    type: 'jobs:external-edit',
    data: { reloaded: true, count: this.jobs.size }
  });
}

// UI shows notification
"Jobs reloaded (external edit detected)"
```

**Pros:** User awareness, UI can refresh automatically
**Cons:** Requires UI changes

---

## Summary

**Problem:** Agent fixes jobs.json on disk, but memory stays stale → scheduler broken → user must restart app

**Solution:** `reload_jobs()` tool refreshes memory from disk in <100ms

**Usage:** Call `reload_jobs()` after manually editing jobs.json via bash/filesystem tools

**Benefit:** No app restart needed, WebSocket stays connected, agent context preserved

**Related:** Works with Issue 40 (automatic stale job recovery) for complete job state management
