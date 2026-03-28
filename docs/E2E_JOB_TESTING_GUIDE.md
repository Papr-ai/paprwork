# End-to-End Job Testing Guide

**Created:** 2026-03-28

This guide explains how to test the job scheduling system comprehensively, covering both agent and non-agent jobs, scheduling behavior, error handling, and run history.

---

## Test Suite Overview

We provide **two complementary test approaches**:

### 1. Manual E2E Test Script (Recommended)
**File:** `scripts/test-jobs-e2e.mjs`  
**Run:** `npm run test:jobs-e2e`

- ✅ Tests real job execution (no mocks)
- ✅ Tests real scheduling logic
- ✅ Tests run history persistence
- ✅ Tests error classification
- ✅ Colored output with clear pass/fail
- ✅ Works around Vitest worker serialization issues

**Best for:** Validating the complete system works in a real environment.

### 2. Vitest Integration Tests
**File:** `tests/jobs-e2e-simple.test.ts`  
**Run:** `npm test tests/jobs-e2e-simple.test.ts`

- ✅ Automated test suite
- ✅ Part of CI/CD pipeline
- ✅ Granular test isolation
- ⚠️ May encounter Vitest worker issues with complex mocking

**Best for:** Regression testing in CI.

---

## Running the Tests

### Quick Test (Manual Script)

```bash
# 1. Build the project first
npm run build

# 2. Start the app in one terminal
npm start

# 3. In another terminal, run the E2E test script
npm run test:jobs-e2e
```

**Expected output:**
```
╔══════════════════════════════════════════════════════════╗
║     END-TO-END JOB SCHEDULER TEST SUITE                 ║
╚══════════════════════════════════════════════════════════╝

============================================================
TEST 1: Bash Job Execution
============================================================
Creating bash job...
  Job ID: job-abc123
Running job...
✓ Bash job completed successfully
✓ Run history recorded correctly
  Duration: 45ms
✓ Cleanup completed

... (8 tests total)

============================================================
SUMMARY
============================================================

✓ All 8 tests passed!
```

### Vitest Tests

```bash
# Run all job-related tests
npm test -- jobs-e2e-simple

# Run specific test
npm test -- jobs-e2e-simple -t "bash job runs and records history"

# Watch mode
npm run test:watch -- jobs-e2e-simple
```

---

## Test Coverage

### Test 1: Bash Job Execution
**What it tests:**
- ✅ Bash job creates successfully
- ✅ Bash job runs to completion
- ✅ Exit code 0 for success
- ✅ Run history records execution
- ✅ Statistics computed correctly

**Expected behavior:**
- Job status: `pending` → `running` → `completed`
- Exit code: 0
- Run history: 1 entry with `status: "completed"`

### Test 2: Bash Job Retry Logic
**What it tests:**
- ✅ Failed bash job retries up to `maxAttempts`
- ✅ Exponential backoff between retries
- ✅ All attempts recorded in run history
- ✅ Final status is `failed` after all retries exhausted

**Expected behavior:**
- 3 run history entries (one per attempt)
- Final status: `failed`
- Each attempt has increasing `duration` due to backoff

### Test 3: Scheduled Job (Interval)
**What it tests:**
- ✅ Job with `intervalMs` computes `nextRunAt`
- ✅ `nextRunAt` is in the future
- ✅ Job runs when triggered by scheduler
- ✅ `nextRunAt` advances after execution

**Expected behavior:**
- `nextRunAt` = now + `intervalMs`
- After execution: `nextRunAt` advances by `intervalMs`

### Test 4: Cron Schedule
**What it tests:**
- ✅ Job with `cron` expression computes correct `nextRunAt`
- ✅ `nextRunAt` matches cron pattern (e.g., minute 0 for `0 * * * *`)
- ✅ Timezone support (optional)

**Expected behavior:**
- `nextRunAt` minute matches cron pattern
- For `*/5 * * * *`, minute is divisible by 5

### Test 5: Python Job Execution
**What it tests:**
- ✅ Python job creates venv automatically
- ✅ Python script executes successfully
- ✅ Output captured in logs
- ✅ Run history records execution

**Expected behavior:**
- Status: `completed`
- Exit code: 0
- Logs contain Python script output

### Test 6: Run History Statistics
**What it tests:**
- ✅ Multiple runs accumulate in history
- ✅ Statistics computed correctly (`totalRuns`, `completedRuns`, `failedRuns`, `avgDuration`)
- ✅ History retrievable with limit

**Expected behavior:**
- 5 runs → `totalRuns: 5`
- All successful → `completedRuns: 5, failedRuns: 0`
- Average duration computed correctly

### Test 7: Error Classification (Permanent vs Transient)
**What it tests:**
- ✅ Permanent errors (e.g., "Invalid API key") stop retries immediately
- ✅ Transient errors (e.g., "Connection timeout") allow full retry cycle
- ✅ One-shot schedules disabled after permanent errors
- ✅ Run history shows correct attempt counts

**Expected behavior:**
- **Permanent error:**
  - 1 attempt only (no retries)
  - One-shot schedule disabled
  - Logs: "Permanent error detected. Stopping retries."
- **Transient error:**
  - 3 attempts (full retry cycle)
  - Schedule remains enabled

### Test 8: Scheduled Job NextRunAt Advancement
**What it tests:**
- ✅ `nextRunAt` advances by `intervalMs` after execution
- ✅ Advancement persists in `job.json` and `jobs.json`
- ✅ Scheduler picks up new `nextRunAt` on next tick

**Expected behavior:**
- Initial: `nextRunAt = T`
- After run: `nextRunAt = T + intervalMs`
- Difference is precisely `intervalMs` (±1 second tolerance)

### Test 9: Agent Job Execution (Future)
**What it tests:**
- ✅ Agent job creates isolated session
- ✅ Agent produces output
- ✅ Exit code 0 for success, 1 for no output
- ✅ Run history records agent execution

**Expected behavior:**
- Status: `completed` if output produced
- Status: `failed` if no output or exception
- Run history: includes agent-specific metadata

### Test 10: Log Rotation
**What it tests:**
- ✅ Logs accumulate across multiple runs
- ✅ Logs automatically pruned at 2MB threshold
- ✅ Last 2000 lines preserved after pruning

**Expected behavior:**
- Logs grow with each run
- After 2MB: `run.log` trimmed to 2000 lines
- Console: `[JobsService] Pruned log for job X to 2000 lines`

---

## Expected Scheduler Behavior

### On App Startup

1. **Initialization:**
   ```
   [JobsScheduler] Tick started at 2026-03-28T10:00:00.000Z
   [JobsScheduler] Checking 12 total jobs
   ```

2. **Reconciliation:**
   ```
   [JobsScheduler] Reconciling stale running jobs...
   [JobsScheduler] Reconciling schedule states...
   ```

3. **First Tick:**
   ```
   [JobsScheduler] Tick completed in 15ms - enabled: 8, due: 2, launched: 2, skipped: 0, next wake: 30s
   ```

### During Active Job

```
[JobsScheduler] Launching job job-abc123 (Daily Sync) for slot 2026-03-28T10:00:00.000Z
[JobsService] Starting job job-abc123 (Daily Sync)
[JobsService] Job job-abc123 completed successfully in 2.3s
[JobsScheduler] Tick completed in 2305ms - enabled: 8, due: 1, launched: 1, skipped: 0, next wake: 60s
```

### With Overlapping Runs

```
[JobsScheduler] Skipping job job-def456 (Long Task) - status: running
[JobsScheduler] Tick completed in 5ms - enabled: 8, due: 1, launched: 0, skipped: 1, next wake: 30s
```

### With Retries

```
[JobsService] Attempt 1/3 failed. Next retry at 2026-03-28T10:01:00.000Z (in 1000ms)
[JobsService] Attempt 2/3 failed. Next retry at 2026-03-28T10:01:02.000Z (in 2000ms)
[JobsService] Attempt 3/3 failed. Job marked as failed.
```

### With Permanent Error

```
[JobsService] Error classification: Permanent - Contains 'Invalid API key'
[JobsService] Permanent error detected. Stopping retries.
[JobsService] One-shot schedule disabled due to permanent error.
```

---

## Verification Checklist

After running tests, verify the following:

### ✅ Job Execution
- [ ] Bash jobs execute successfully
- [ ] Python jobs create venv and execute
- [ ] Agent jobs run (when properly configured)
- [ ] Exit codes are correct (0 = success, 1 = failure)

### ✅ Scheduling
- [ ] `intervalMs` jobs compute `nextRunAt` correctly
- [ ] `cron` jobs compute `nextRunAt` matching pattern
- [ ] `atTime` one-shot jobs only run once
- [ ] `nextRunAt` advances after each execution
- [ ] Scheduler logs show "enabled", "due", "launched", "skipped" counts

### ✅ Error Handling
- [ ] Failed jobs retry up to `maxAttempts`
- [ ] Exponential backoff applied between retries
- [ ] Permanent errors stop retries immediately
- [ ] Transient errors allow full retry cycle
- [ ] One-shot schedules disabled after permanent errors

### ✅ Run History
- [ ] Every execution recorded in `~/Papr/data/job-runs.jsonl`
- [ ] History includes `runId`, `status`, `duration`, `exitCode`, `error`, `attempt`
- [ ] Statistics computed correctly (`totalRuns`, `completedRuns`, `failedRuns`, `avgDuration`)
- [ ] History pruning works (max 5000 runs / 5MB)

### ✅ Log Management
- [ ] Logs accumulated in `~/papr-jobs/{jobId}/logs/run.log`
- [ ] Logs rotated at 2MB threshold
- [ ] Last 2000 lines preserved after rotation
- [ ] Console shows pruning message

### ✅ Concurrency
- [ ] Overlapping runs blocked (only 1 instance at a time)
- [ ] Scheduler skips jobs with `status: "running"`
- [ ] Lease prevents double-execution
- [ ] Logs show "skipped" count when jobs are running

### ✅ State Persistence
- [ ] `job.json` updated after each run
- [ ] `jobs.json` index synchronized
- [ ] `nextRunAt` persists across app restarts
- [ ] Run history survives app restarts

---

## Troubleshooting

### Jobs Not Running on Schedule

**Check:**
1. Is schedule enabled? `job.schedule.enabled === true`
2. Is `nextRunAt` in the past? If yes, job is due.
3. Is job status `running` or `waiting_permission`? Scheduler skips these.
4. Are scheduler logs showing "due" and "launched" counts?

**Debug:**
```bash
# Check scheduler logs
grep "\[JobsScheduler\]" ~/Library/Logs/Electron/main.log

# Check job status
sqlite3 ~/.paprwork-v2/jobs.db "SELECT id, name, status, schedule->>'enabled' as enabled, scheduleState->>'nextRunAt' as nextRunAt FROM jobs WHERE schedule IS NOT NULL"
```

### Jobs Always Failing

**Check:**
1. Is the command/script valid? Test manually: `bash -c "echo test"`
2. Are dependencies installed? (Python venv, npm packages)
3. Are environment variables set? Check `env` field in job.
4. Are custom keys available? Check Settings → Custom Keys.

**Debug:**
```bash
# Read job logs
cat ~/papr-jobs/{jobId}/logs/run.log

# Check error classification
grep "Error classification" ~/papr-jobs/{jobId}/logs/run.log
```

### Run History Not Recording

**Check:**
1. Is `~/Papr/data/job-runs.jsonl` being created?
2. Are logs showing `[JobRunHistory] Appended run...`?

**Debug:**
```bash
# Check if history file exists
ls -lh ~/Papr/data/job-runs.jsonl

# Read recent entries
tail -20 ~/Papr/data/job-runs.jsonl

# Count total entries
wc -l ~/Papr/data/job-runs.jsonl
```

### Scheduler Not Waking

**Check:**
1. Are there any enabled jobs? Scheduler sleeps if none.
2. Is `nextRunAt` in the distant future? Scheduler wakes at `nextRunAt`.
3. Are logs showing "next wake: Xs"?

**Debug:**
```bash
# Check scheduler wake time
grep "next wake" ~/Library/Logs/Electron/main.log | tail -5

# Check enabled jobs
sqlite3 ~/.paprwork-v2/jobs.db "SELECT COUNT(*) FROM jobs WHERE schedule->>'enabled' = 'true'"
```

---

## Performance Benchmarks

| Test | Expected Duration | Tolerance |
|------|-------------------|-----------|
| Bash job execution | < 500ms | ±200ms |
| Python job execution | < 2s (first run) | ±500ms |
| Python job execution | < 1s (cached venv) | ±300ms |
| Job with 3 retries | < 5s | ±1s |
| Schedule state computation | < 50ms | ±20ms |

---

## Test Data

All tests use the `E2E Test: ...` prefix for easy identification and cleanup:

- `E2E Test: Bash Execution`
- `E2E Test: Bash Retry`
- `E2E Test: Scheduled Interval`
- `E2E Test: Cron Schedule`
- `E2E Test: Python Execution`
- `E2E Test: Log Rotation`

After tests complete, cleanup is automatic (all `E2E Test` jobs are deleted).

---

## Manual Testing Scenarios

### Scenario 1: Create and Run a Bash Job

```bash
# Via CLI (in app)
> Create a bash job called "Test Job" that runs: echo "Hello from test job"

# Verify
> List all jobs

# Run manually
> Run job "Test Job"

# Check history
> Show run history for "Test Job"
```

**Expected:**
- Job creates with status `pending`
- Manual run completes successfully
- History shows 1 run with `status: "completed"`, `exitCode: 0`

### Scenario 2: Schedule a Job with Interval

```bash
# Via CLI (in app)
> Create a bash job called "Every Minute" that runs every 60 seconds: echo "Tick"

# Verify schedule
> List all jobs
# Should show: nextRunAt in ~60 seconds

# Wait 70 seconds
# Check if job ran
> Show run history for "Every Minute"
```

**Expected:**
- Job runs automatically after ~60 seconds
- History shows 1 run
- `nextRunAt` advances by 60 seconds

### Scenario 3: Test Retry Logic

```bash
# Via CLI (in app)
> Create a bash job called "Retry Test" that fails: exit 1
> Set max retries to 3 with 1 second backoff

# Run it
> Run job "Retry Test"

# Check history
> Show run history for "Retry Test"
```

**Expected:**
- Job retries 3 times
- History shows 3 entries, all with `status: "failed"`
- Total duration ≈ 1s + 2s + 4s = ~7 seconds (exponential backoff)

### Scenario 4: Test Error Classification

```bash
# Via CLI (in app)
> Create a bash job called "Permanent Error" with command: echo "Invalid API key" && exit 1
> Set it as one-shot schedule for tomorrow
> Set max retries to 5

# Run it
> Run job "Permanent Error"

# Check logs
> Show logs for "Permanent Error"
```

**Expected:**
- Logs show: "Error classification: Permanent - Contains 'Invalid API key'"
- Logs show: "Permanent error detected. Stopping retries."
- Only 1 attempt (no retries)
- Schedule disabled automatically

### Scenario 5: Test Agent Job

```bash
# Via CLI (in app)
> Create an agent job called "Agent Test" that says: "Hello from agent job"
> Run it

# Check result
> Show run history for "Agent Test"
```

**Expected:**
- Job completes successfully
- Exit code: 0 (if output produced)
- History shows 1 run with agent metadata

---

## Debugging Tips

### Enable Verbose Logging

Set environment variables before starting:
```bash
DEBUG=papr:* npm start
```

### Check All Job Files

```bash
# List all jobs
ls -la ~/papr-jobs/

# Check specific job
cat ~/papr-jobs/{jobId}/job.json
cat ~/papr-jobs/{jobId}/logs/run.log

# Check run history
cat ~/Papr/data/job-runs.jsonl | grep "{jobId}"
```

### Monitor Scheduler Activity

```bash
# Watch scheduler logs in real-time
tail -f ~/Library/Logs/Electron/main.log | grep "\[JobsScheduler\]"
```

### Inspect Run History Database

```bash
# Get stats for all jobs
cat ~/Papr/data/job-runs.jsonl | \
  jq -s 'group_by(.jobId) | map({jobId: .[0].jobId, runs: length})' | \
  jq -r '.[] | "\(.jobId): \(.runs) runs"'
```

---

## Known Limitations

### Vitest Worker Serialization
**Issue:** Complex mocking in Vitest causes `TypeError: The first argument must be of type string or an instance of Buffer...`

**Workaround:** Use the manual E2E script (`scripts/test-jobs-e2e.mjs`) for comprehensive testing. The Vitest tests are kept simple to avoid serialization issues.

**Related:** See previous session summary for details on this environment-specific issue.

### Agent Job Testing Requires API Keys
**Issue:** Agent jobs need valid API keys or OAuth tokens to execute.

**Workaround:** Use mocked agent service for tests, or run manual tests with real API keys.

### Time-Sensitive Tests
**Issue:** Tests involving `setTimeout` or `sleep` can be flaky on slow systems.

**Workaround:** Use generous timeouts in Vitest (15-30 seconds), or use fake timers.

---

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Job Scheduler Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '24'
      - run: npm install
      - run: npm run build
      - run: npm test tests/jobs-e2e-simple.test.ts
```

### Pre-Push Hook

Add to `.git/hooks/pre-push`:
```bash
#!/bin/bash
npm run build && npm test tests/jobs-e2e-simple.test.ts
```

---

## Future Enhancements

### Add Agent Job Tests with Real API Calls
**Why:** Current tests mock agent service. Real API calls verify end-to-end integration.

**Implementation:**
- Create test jobs with real API keys (env vars)
- Use `gpt-4o-mini` or Claude Haiku (cheap models)
- Verify streaming, tool calling, and error handling

### Add Load Testing
**Why:** Verify scheduler handles high job counts (100+ jobs).

**Implementation:**
- Create 100 jobs with 1-minute intervals
- Verify scheduler tick completes in <1 second
- Verify no memory leaks over 1 hour

### Add Timezone Tests
**Why:** Verify cron schedules work across timezones.

**Implementation:**
- Create jobs with `timezone: "America/Los_Angeles"`
- Verify `nextRunAt` respects timezone
- Test DST transitions

---

## References

- [Job Scheduler Improvements Documentation](JOB_SCHEDULER_IMPROVEMENTS_2026-03-28.md)
- [Robust Job Scheduler Implementation](ROBUST_JOB_SCHEDULER_IMPLEMENTATION.md)
- [Error Classifier Implementation](../src/gateway/services/jobs/errorClassifier.ts)
- [Run History Implementation](../src/gateway/services/jobs/JobRunHistory.ts)
- [Schedule Engine](../src/gateway/services/jobs/scheduleEngine.ts)

---

**Last Updated:** 2026-03-28
