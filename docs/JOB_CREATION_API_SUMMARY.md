# Job Creation API Implementation Summary

**Date:** 2026-03-30

## What Was Implemented

Added `/api/jobs/create` endpoint to the Gateway API, allowing mini-apps to programmatically create jobs.

## Files Changed

### 1. `src/gateway/index.ts`
**Changes:**
- Added `CreateJobInput` import from `JobsService`
- Added rate limiter state (`jobCreationRateLimit` Map)
- Added `/api/jobs/create` POST endpoint with:
  - Rate limiting (10 jobs/min per app)
  - Command size validation (100KB max)
  - Full `CreateJobInput` validation via `JobsService.createJob()`

**Location:** Lines 662-745 (after `/api/jobs/run` endpoint)

### 2. `src/core/agents/SystemPrompt.ts`
**Changes:**
- Added new section "6. Mini-Apps Can Create Jobs Programmatically"
- Documented the `/api/jobs/create` endpoint with example usage
- Re-numbered subsequent sections (7-11)

**Location:** Lines 977-1009

### 3. `docs/MINI_APP_JOB_CREATION.md` (NEW)
**Contents:**
- Complete documentation of the new feature
- Security measures explanation
- Usage examples (simple, lazy creation, pipeline building)
- Rate limit handling strategies
- Testing instructions

### 4. `scripts/test-job-creation-api.mjs` (NEW)
**Contents:**
- Automated test script for the endpoint
- Tests: basic creation, rate limiting, size validation
- Auto-cleanup of test jobs

## Security Measures

### 1. Rate Limiting ⭐ Primary Defense
- **Limit:** 10 jobs per minute per app
- **Window:** 60 seconds (sliding)
- **Status:** 429 (Too Many Requests)
- **Message:** Includes wait time remaining

### 2. Size Validation
- **Limit:** 100KB command size
- **Reason:** Prevents abuse, legitimate commands are small
- **Status:** 400 (Bad Request)

### 3. Existing Validation
- All `create_job` tool validation applies
- Zod schema validation for all fields
- Job type, schedule, dependencies, etc.

### 4. No Privilege Escalation
- Mini-apps already have bash access
- Creating jobs is just structured code execution
- No new capabilities granted

## API Specification

### Request
```http
POST /api/jobs/create
Content-Type: application/json

{
  "name": "Job Name",
  "type": "bash" | "python" | "node" | "swift" | "agent" | "subagent",
  "command": "echo hello",
  "appId": "mini-app-id",  // Optional, for rate limiting
  ... (all CreateJobInput fields supported)
}
```

### Response (Success)
```json
{
  "success": true,
  "jobId": "uuid",
  "name": "Job Name",
  "type": "bash",
  "status": "pending"
}
```

### Response (Rate Limited)
```json
{
  "error": "Rate limit exceeded. Max 10 jobs per minute per app. Try again in 45s."
}
```

### Response (Size Error)
```json
{
  "error": "Command too large. Maximum 100KB allowed."
}
```

## Use Cases

1. **Lazy Job Creation** - LinkedIn Autopilot creates action jobs on-demand
2. **User-Configured Workflows** - Pipeline builders where users configure in UI
3. **Dynamic Pipelines** - Generate job chains based on user input

## Testing

### Manual Test
```bash
# Gateway must be running (npm start)

# Test basic creation
node scripts/test-job-creation-api.mjs
```

### Test Coverage
- ✅ Basic job creation
- ✅ Rate limiting (11 jobs quickly)
- ✅ Size validation (>100KB command)
- ✅ Auto-cleanup

## Architecture Benefits

**Before:** Pre-create all possible jobs upfront
- Pro: Jobs always available
- Con: Cron overhead for unused jobs
- Con: Less flexible

**After:** Hybrid approach
- Pre-create common jobs (reliability)
- Dynamic creation for user-specific needs (flexibility)
- Best of both worlds

## Integration Example

```typescript
// Mini-app: app.ts
async function createActionJob(actionType: string) {
  const res = await fetch('/api/jobs/create', {
    method: 'POST',
    body: JSON.stringify({
      name: `LinkedIn ${actionType} Action`,
      type: "python",
      command: `python3 code/${actionType}.py`,
      requirements: ["linkedin-api", "sqlite-utils"],
      schedule: {
        enabled: true,
        intervalMs: 60000
      }
    })
  });

  const { jobId } = await res.json();
  return jobId;
}

// User enables "view_profile" action
const jobId = await createActionJob('view_profile');
```

## Next Steps

Optional future enhancements:
1. Per-app quotas (different limits for different apps)
2. Type restrictions (prevent mini-apps from creating agent jobs)
3. Job templates (pre-defined configs apps can instantiate)
4. Bulk creation endpoint (create multiple jobs atomically)

## Related Documentation

- [Full Feature Doc](./MINI_APP_JOB_CREATION.md)
- [Jobs Architecture](./APP_AND_JOBS_GUIDE.md)
- [Key Substitution](./KEY_SUBSTITUTION_ARCHITECTURE.md)
