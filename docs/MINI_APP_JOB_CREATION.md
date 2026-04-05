# Mini-App Job Creation API

**Added:** 2026-03-30

## Overview

Mini-apps can now programmatically create jobs via the `/api/jobs/create` endpoint. This enables dynamic automation workflows where mini-apps generate job pipelines based on user configuration in the UI.

## Why This Feature?

**Use Cases:**
1. **Lazy Job Creation** - LinkedIn Autopilot creates action jobs on-demand when campaigns need them
2. **User-Configured Workflows** - Data pipeline builders where users configure scrapers in UI
3. **Dynamic Pipelines** - Workflow generators that create job chains (A → B → C) from user descriptions

**Security Posture:**
- Mini-apps already have full bash access via `/api/bash/run` with custom key substitution
- Creating a job is actually *safer* than raw bash — jobs have tracking, logging, status management
- Jobs run in isolated directories (`~/Papr/jobs/{jobId}/`)
- No privilege escalation — just a structured way to run code

## Endpoint

```
POST /api/jobs/create
Content-Type: application/json
```

**Request Body:** Same as `create_job` tool parameters (see `CreateJobInput` type)

```typescript
{
  name: string;              // Job display name
  type: "shell" | "bash" | "node" | "python" | "swift" | "agent" | "subagent";
  folder?: string;           // Group label (e.g. "ingestion", "processing")
  command?: string;          // Command to execute
  requirements?: string[];   // Python/Node packages to install
  dependsOn?: Array<{        // Upstream dependencies
    jobId: string;
    onStatus: "completed" | "failed";
    autoTrigger?: boolean;   // Auto-run when parent finishes
  }>;
  runtimeCalls?: string[];   // Job IDs called via /api/jobs/run (for visualization)
  retries?: {
    maxAttempts: number;
    backoffMs: number;
  };
  schedule?: {
    enabled: boolean;
    cron?: string;           // Cron expression
    intervalMs?: number;     // Milliseconds between runs
    atTime?: string;         // Time-of-day (e.g. "09:00")
  };
  // ... and more (see CreateJobInput type)
}
```

**Response:**

```typescript
// Success
{
  success: true,
  jobId: string,
  name: string,
  type: string,
  status: string
}

// Error
{
  error: string
}
```

## Security Measures

### 1. Rate Limiting (Primary Defense)

**Limit:** 10 jobs per minute per app

```typescript
// Rate limiter tracks per-app creation counts
const jobCreationRateLimit = new Map<string, { count: number; windowStart: number }>();
const MAX_JOBS_PER_MINUTE = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
```

**Why 10/min?**
- Prevents spam attacks
- Allows legitimate batch creation (e.g., creating 7 LinkedIn action jobs on campaign setup)
- Resets every 60 seconds (sliding window)

**Response when exceeded:**
```json
{
  "error": "Rate limit exceeded. Max 10 jobs per minute per app. Try again in 45s."
}
```

### 2. Size Validation

**Command size capped at 100KB:**

```typescript
if (input.command && input.command.length > 100_000) {
  res.status(400).json({
    error: "Command too large. Maximum 100KB allowed."
  });
}
```

**Why 100KB?**
- Prevents abuse (massive job creation)
- Legitimate commands rarely exceed a few KB
- Large scripts should be in files, not inline

### 3. Zod Schema Validation

All existing `create_job` tool validation applies:
- Job type validation (must be valid JobType)
- Schedule validation (cron syntax, interval bounds)
- Dependency validation (jobId must exist)
- Requirements validation (package names)

### 4. No Privilege Escalation

Mini-apps already have:
- ✅ Bash access via `/api/bash/run`
- ✅ Custom key substitution (`${KEY_NAME}`)
- ✅ SQLite database access via `/api/db/query`

Creating jobs doesn't give them anything new — just a structured, trackable way to run code.

## Examples

### Example 1: Simple Python Job

```typescript
// Mini-app: app.ts
async function createScraperJob() {
  const res = await fetch('/api/jobs/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: "Reddit Scraper",
      type: "python",
      command: "python3 code/scraper.py",
      requirements: ["requests", "sqlite-utils"],
      schedule: {
        enabled: true,
        intervalMs: 3600000 // Every hour
      }
    })
  });

  const { jobId } = await res.json();
  console.log(`Created job: ${jobId}`);
  
  // Optionally run it immediately
  await fetch('/api/jobs/run', {
    method: 'POST',
    body: JSON.stringify({ jobId })
  });
}
```

### Example 2: Lazy Job Creation (LinkedIn Autopilot)

```typescript
// Detect campaign needs a new action type
async function ensureActionJob(actionType: string) {
  // Check if job already exists
  const jobsRes = await fetch('/api/jobs/list');
  const { jobs } = await jobsRes.json();
  
  const existing = jobs.find(j => 
    j.name === `LinkedIn ${actionType} Action`
  );
  
  if (existing) {
    console.log(`Job already exists: ${existing.id}`);
    return existing.id;
  }

  // Create on-demand
  const createRes = await fetch('/api/jobs/create', {
    method: 'POST',
    body: JSON.stringify({
      name: `LinkedIn ${actionType} Action`,
      type: "python",
      command: `python3 code/${actionType}.py`,
      requirements: ["linkedin-api", "sqlite-utils"],
      schedule: {
        enabled: true,
        intervalMs: 60000 // Run every minute
      }
    })
  });

  const { jobId } = await createRes.json();
  console.log(`Created ${actionType} job: ${jobId}`);
  return jobId;
}

// User enables "view_profile" action in campaign
await ensureActionJob('view_profile');
```

### Example 3: Job Pipeline from UI

```typescript
// User configures a data pipeline in the UI
async function createPipeline(config: {
  source: string;
  transform: string;
  destination: string;
}) {
  // Create scraper job
  const scraperRes = await fetch('/api/jobs/create', {
    method: 'POST',
    body: JSON.stringify({
      name: "Pipeline: Scraper",
      type: "python",
      command: `python3 code/scrape.py --source ${config.source}`,
      requirements: ["requests", "beautifulsoup4"]
    })
  });
  const { jobId: scraperId } = await scraperRes.json();

  // Create transformer job (depends on scraper)
  const transformRes = await fetch('/api/jobs/create', {
    method: 'POST',
    body: JSON.stringify({
      name: "Pipeline: Transform",
      type: "python",
      command: `python3 code/transform.py --type ${config.transform}`,
      requirements: ["pandas"],
      dependsOn: [{
        jobId: scraperId,
        onStatus: "completed",
        autoTrigger: true // Auto-run when scraper finishes
      }]
    })
  });
  const { jobId: transformerId } = await transformRes.json();

  // Create destination job (depends on transformer)
  const destRes = await fetch('/api/jobs/create', {
    method: 'POST',
    body: JSON.stringify({
      name: "Pipeline: Load",
      type: "bash",
      command: `./load.sh ${config.destination}`,
      dependsOn: [{
        jobId: transformerId,
        onStatus: "completed",
        autoTrigger: true
      }]
    })
  });
  const { jobId: destId } = await destRes.json();

  console.log(`Pipeline created: ${scraperId} → ${transformerId} → ${destId}`);
  
  // Start the pipeline
  await fetch('/api/jobs/run', {
    method: 'POST',
    body: JSON.stringify({ jobId: scraperId })
  });
}
```

## When to Use

**Use `/api/jobs/create` when:**
- Dynamic job generation based on user input
- Lazy creation patterns (only create jobs when needed)
- User-configured workflows
- Runtime job pipeline construction

**Use agent `create_job` tool when:**
- Initial setup (creating baseline jobs)
- Complex pipelines with many dependencies
- Bulk job creation (>10 jobs)
- Jobs requiring agent reasoning to configure

## Rate Limit Handling

**Strategy for apps that might hit the limit:**

```typescript
async function createJobWithRetry(jobConfig: CreateJobInput, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch('/api/jobs/create', {
      method: 'POST',
      body: JSON.stringify(jobConfig)
    });

    if (res.ok) {
      return await res.json();
    }

    if (res.status === 429) {
      // Extract wait time from error message
      const { error } = await res.json();
      const match = error.match(/Try again in (\d+)s/);
      const waitSeconds = match ? parseInt(match[1]) : 60;
      
      console.log(`Rate limited. Waiting ${waitSeconds}s...`);
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }

    // Other error
    throw new Error((await res.json()).error);
  }

  throw new Error('Failed to create job after retries');
}
```

## Architecture Benefits

**Before:** Pre-create all possible jobs upfront
- Pro: Jobs always available
- Con: Cron overhead for unused jobs
- Con: Less flexible (must anticipate all types)

**After:** Hybrid approach
- Pre-create common/baseline jobs for reliability
- Use `/api/jobs/create` for dynamic/user-configured jobs
- Best of both worlds: reliability + flexibility

## Implementation Details

**Location:** `src/gateway/index.ts`

**Rate limiter state:**
```typescript
const jobCreationRateLimit = new Map<
  string,
  { count: number; windowStart: number }
>();
```

**Logging:**
```typescript
console.log(
  `[Gateway] /api/jobs/create: App ${appId} created job ${job.id} (${job.name})`
);
```

**Type safety:**
```typescript
import type { CreateJobInput } from "./services/JobsService.js";
```

## Testing

**Manual test:**
```bash
# Create a simple bash job
curl -X POST http://localhost:18789/api/jobs/create \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Job",
    "type": "bash",
    "command": "echo Hello from mini-app job"
  }'

# Response: { "success": true, "jobId": "...", ... }

# Run it
curl -X POST http://localhost:18789/api/jobs/run \
  -H "Content-Type: application/json" \
  -d '{ "jobId": "..." }'
```

**Rate limit test:**
```bash
# Create 11 jobs quickly (should fail on 11th)
for i in {1..11}; do
  curl -X POST http://localhost:18789/api/jobs/create \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"Job $i\",\"type\":\"bash\",\"command\":\"echo $i\"}"
  echo
done
```

## Future Enhancements

**Potential additions:**
1. **Per-app quotas** - Different limits for different apps (e.g., LinkedIn Autopilot gets 20/min)
2. **Type restrictions** - Optionally prevent mini-apps from creating `agent` or `subagent` jobs
3. **Job templates** - Pre-defined job configs mini-apps can instantiate
4. **Bulk creation endpoint** - Create multiple jobs in one request (transactional)

## Related Documentation

- [Jobs Architecture](./APP_AND_JOBS_GUIDE.md)
- [Key Substitution](./KEY_SUBSTITUTION_ARCHITECTURE.md)
- [Mini-App REST API](./MINI_APP_REST_API.md)
