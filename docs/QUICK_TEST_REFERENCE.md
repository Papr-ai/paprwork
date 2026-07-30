# Quick Test Reference

## Run All E2E Job Tests

### Basic Tests (Bash, Python, Scheduling)
```bash
npm run test:jobs-e2e
```
**Tests:** 8 tests covering bash, python, scheduling, retry, error classification  
**Runtime:** ~14 seconds

### Advanced Tests (Agent Jobs, Restart Scenarios)
```bash
npm run test:jobs-advanced
```
**Tests:** 8 tests covering agent jobs, scheduled agents, app restart, persistence, interrupted jobs, concurrency  
**Runtime:** ~5 seconds

### Run Both Suites
```bash
npm run test:jobs-e2e && npm run test:jobs-advanced
```
**Total:** 16 tests in ~20 seconds  
**Expected output:**
```
✓ All 8 tests passed!  (basic)
✓ All 8 tests passed!  (advanced)
```

---

## Run Individual Test Suites

### Error Classification Tests
```bash
npm test -- tests/jobs-e2e-simple.test.ts -t "Error Classification"
```
**Tests:** 5/5 (rate limit, invalid API key, timeout, 401, unknown)

### Run History Tests
```bash
npm test -- tests/jobs-e2e-simple.test.ts -t "Run History"
```
**Tests:** 1/1 (store and retrieve multiple runs with stats)

### Schedule Engine Tests
```bash
npm test -- tests/schedule-engine.test.ts
```
**Tests:** Core scheduling logic (isScheduleDue, computeNextRunAt, etc.)

---

## What Gets Tested

### ✅ Job Execution
- Bash jobs complete successfully
- Python jobs create venv and execute
- Exit codes correct (0 = success, non-zero = failure)

### ✅ Scheduling
- intervalMs computes nextRunAt correctly
- Cron expressions parse correctly
- nextRunAt advances by exact interval after execution

### ✅ Error Handling
- Failed jobs retry up to maxAttempts
- Exponential backoff between retries
- Transient errors (timeouts, network) allow retries
- Permanent errors (401, invalid API key) stop immediately

### ✅ Run History
- Every execution recorded in $PAPR_HOME/data/job-runs.jsonl
- Statistics computed (totalRuns, completedRuns, failedRuns, avgDuration)
- History survives app restarts

### ✅ Logs
- Logs accumulated in ~/papr-jobs/{jobId}/logs/run.log
- Large logs automatically rotated (2MB threshold)

---

## Troubleshooting

### Tests Fail with "Module compiled against different Node.js version"
**Cause:** Native modules need rebuilding for Electron  
**Fix:** `npx @electron/rebuild`

### Python Test Fails
**Cause:** Python not installed or venv creation fails  
**Fix:** Install Python 3: `brew install python3`

### Tests Timeout
**Cause:** App not running or Gateway not started  
**Fix:** Ensure `npm start` is running in another terminal

---

## Quick Verification (No Tests Needed)

Check if jobs are working manually:

```bash
# 1. Start the app
npm start

# 2. In the app's chat:
> Create a bash job called "Quick Test" that runs: echo "Works!"
> Run job "Quick Test"
> Show run history for "Quick Test"

# 3. Expected:
# - Job completes successfully
# - History shows 1 run with status "completed"
# - Logs show "Works!"
```

---

## Full Testing Guide

See [`docs/E2E_JOB_TESTING_GUIDE.md`](./E2E_JOB_TESTING_GUIDE.md) for:
- Complete test coverage details
- Manual testing scenarios
- Performance benchmarks
- Debugging tips
- CI/CD integration examples
