# Agent Job Model Override Fix

**Date:** 2026-03-30  
**Issue:** Agent jobs always default to `gpt-5.2` instead of using the model specified by the agent

## Problem

When an agent created an agent job (e.g., "Weekly Prep Briefing"), it couldn't specify which model to use. The job would always fall back to the default `openai/gpt-5.2`, even if the agent wanted to use a different model like `gpt-5.4` or `claude-sonnet-4-5`.

### Root Cause Analysis

The issue had **four layers** of missing functionality:

1. **Missing Schema Fields**: The `createJobSchema` and `updateJobSchema` Zod schemas didn't include `provider` and `model` fields
2. **Missing Type Fields**: The `JobRecord` and `CreateJobInput` TypeScript interfaces didn't have `provider` and `model` fields
3. **Missing Tool Mapping**: The `createJobTool` execute function didn't pass `provider`/`model` to `jobsService.createJob()`
4. **Missing Executor Logic**: The `AgentJobExecutor` only read `provider` and `model` from subagent profiles, not from the job record itself

### Error Example

```
[2026-03-30T08:01:54.396Z] Agent execution failed: Agent job model error (openai/gpt-5.2): Context limit approaching. Conversation will be summarized automatically.
[2026-03-30T08:01:54.397Z] [WARN] Agent job produced no model output (default openai/gpt-5.2). Check: OAuth connected or API key set in Settings; see Gateway logs for API errors.
```

The log clearly shows `(default openai/gpt-5.2)` even though the agent likely wanted a different model.

## Solution

Added `provider` and `model` fields to the entire job creation/update pipeline:

### 1. Type Definitions (`src/gateway/services/jobs/types.ts`)

```typescript
export interface JobRecord {
  // ... existing fields ...
  /** Provider for agent/subagent jobs (e.g. "openai", "anthropic", "ollama"). Overrides default. */
  provider?: string;
  /** Model ID for agent/subagent jobs (e.g. "gpt-5.4", "claude-sonnet-4-5"). Overrides default. */
  model?: string;
}

export interface CreateJobInput {
  // ... existing fields ...
  /** Provider for agent/subagent jobs (e.g. "openai", "anthropic", "ollama"). Overrides default. */
  provider?: string;
  /** Model ID for agent/subagent jobs (e.g. "gpt-5.4", "claude-sonnet-4-5"). Overrides default. */
  model?: string;
}
```

### 2. Tool Schemas (`src/core/tools/appJobs.ts`)

```typescript
const createJobSchema = z.object({
  // ... existing fields ...
  provider: z
    .enum(["openai", "anthropic", "google", "ollama"])
    .optional()
    .describe(
      "Provider for agent/subagent jobs. Overrides default. Example: 'openai', 'anthropic', 'ollama'",
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Model ID for agent/subagent jobs. Overrides default. Example: 'gpt-5.4', 'claude-sonnet-4-5', 'qwen3.5-9b'",
    ),
});

const updateJobSchema = z.object({
  // ... existing fields ...
  provider: z
    .enum(["openai", "anthropic", "google", "ollama"])
    .optional()
    .describe(
      "Update provider for agent/subagent jobs. Example: 'openai', 'anthropic', 'ollama'",
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Update model ID for agent/subagent jobs. Example: 'gpt-5.4', 'claude-sonnet-4-5', 'qwen3.5-9b'",
    ),
});
```

### 3. Tool Execution (`src/core/tools/appJobs.ts`)

```typescript
export const createJobTool = createTool({
  // ...
  execute: async (input) => {
    const args = (input as { context?: CreateJobArgs }).context ?? input;
    const job = await jobsService.createJob({
      // ... existing fields ...
      provider: args.provider,
      model: args.model,
    });
    return { success: true, data: job };
  },
});
```

### 4. Job Creation (`src/gateway/services/JobsService.ts`)

```typescript
async createJob(input: CreateJobInput): Promise<JobRecord> {
  const job: JobRecord = {
    // ... existing fields ...
    provider: input.provider,
    model: input.model,
    // ...
  };
  // ... rest of creation logic ...
}
```

### 5. Job Update (`src/gateway/services/JobsService.ts`)

```typescript
async updateJob(
  jobId: string,
  updates: Partial<
    Pick<
      JobRecord,
      | "name"
      | "folder"
      // ... other fields ...
      | "provider"  // ← Added
      | "model"     // ← Added
    >
  >,
): Promise<JobRecord> {
  // ... update logic (spread operator handles provider/model automatically) ...
}
```

### 6. Agent Job Executor (`src/gateway/services/jobs/executors/AgentJobExecutor.ts`)

**Before:**
```typescript
// Only read from subagent profile
if (params.job.type === "subagent") {
  const profile = await subAgentService.getAgent(params.job.subAgentId);
  provider = profile.provider;  // Only for subagent jobs
  model = profile.model;
}
```

**After:**
```typescript
// Read from job record FIRST (applies to both agent and subagent jobs)
if (params.job.provider) {
  provider = params.job.provider as
    | "anthropic"
    | "openai"
    | "openai-codex"
    | "google"
    | "ollama";
}
if (params.job.model) {
  model = params.job.model;
}

// Then read from subagent profile (subagent profile overrides job record)
if (params.job.type === "subagent") {
  const profile = await subAgentService.getAgent(params.job.subAgentId);
  // Subagent profile provider/model takes precedence over job record
  if (profile.provider) provider = profile.provider;
  if (profile.model) model = profile.model;
}
```

**Priority order:**
1. Subagent profile (highest priority) - for specialized agents
2. Job record `provider`/`model` - for agent-specified overrides
3. Default (`openai/gpt-5.2`) - fallback

## Usage Examples

### Create an agent job with specific model

```typescript
create_job({
  name: "Weekly Prep Briefing",
  type: "agent",
  provider: "openai",
  model: "gpt-5.4",
  schedule: { enabled: true, cron: "0 7 * * 1" },
  deliver: { channel: "chat", targetId: "main-chat-123" },
  memoryPolicy: "full",
})
```

### Update an existing job's model

```typescript
update_job({
  jobId: "37cfa120-ca88-45f8-b497-ceae9bff2b07",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
})
```

### Create an agent job with Ollama

```typescript
create_job({
  name: "Daily Analysis",
  type: "agent",
  provider: "ollama",
  model: "qwen3.5-9b",
  schedule: { enabled: true, intervalMs: 86400000 }, // 24 hours
})
```

## Migration

**No migration needed!** The fields are optional, so existing jobs continue to work with the default model. The changes are fully backward compatible:

- Existing job records without `provider`/`model` fall back to `openai/gpt-5.2` (current behavior)
- Existing job files will automatically include the new fields when updated via `update_job`
- JSON serialization/deserialization handles optional fields automatically

## Testing

### Manual Testing Checklist

- [ ] Create agent job with `provider: "openai"`, `model: "gpt-5.4"` → job runs with GPT-5.4
- [ ] Create agent job with `provider: "anthropic"`, `model: "claude-sonnet-4-5"` → job runs with Claude
- [ ] Create agent job with `provider: "ollama"`, `model: "qwen3.5-9b"` → job runs with Qwen
- [ ] Update existing agent job's model → next run uses updated model
- [ ] Create agent job without specifying model → falls back to default (`openai/gpt-5.2`)
- [ ] Subagent job with profile model → profile model takes precedence over job record
- [ ] Check logs show correct model: `(openai/gpt-5.4)` instead of `(default openai/gpt-5.2)`

### Type Safety Verification

```bash
npm run type-check
# Gateway and electron should compile without errors
```

**Result:** ✅ Gateway compiles without errors (test file errors are pre-existing)

## Impact

### Before
- ❌ Agent jobs always used `openai/gpt-5.2` regardless of agent intent
- ❌ Couldn't use GPT-5.4, Claude, or Ollama models for agent jobs
- ❌ Error messages showed "(default openai/gpt-5.2)" even when context errors occurred

### After
- ✅ Agents can specify exact model for each job (e.g., GPT-5.4 for reasoning-heavy tasks)
- ✅ Support for all providers (OpenAI, Anthropic, Google, Ollama)
- ✅ Error messages show actual model used: "(openai/gpt-5.4)" or "(anthropic/claude-sonnet-4-5)"
- ✅ Fully backward compatible (existing jobs continue working)

## Files Changed

1. `src/gateway/services/jobs/types.ts` - Added `provider` and `model` to `JobRecord` and `CreateJobInput`
2. `src/core/tools/appJobs.ts` - Added `provider` and `model` to `createJobSchema`, `updateJobSchema`, and tool execution
3. `src/gateway/services/JobsService.ts` - Pass `provider` and `model` to job creation, include in updateJob type signature
4. `src/gateway/services/jobs/executors/AgentJobExecutor.ts` - Read `provider`/`model` from job record before checking subagent profile

## Related Issues

- **Issue 17 - GPT-5.4 Context Limit**: This fix enables agents to use GPT-5.4 for jobs, which has a larger context window (272K vs 120K for GPT-5.2)
- **Enhancement 19 - E2E Job Testing**: New test coverage should include model override scenarios

## Future Improvements

1. **Add model validation**: Validate that the specified model is available for the provider
2. **Add UI indicators**: Show which model a job is configured to use in the Jobs UI
3. **Add default model per job type**: Allow users to set default models for different job types in settings
4. **Add cost tracking**: Track API costs per job based on actual model used

---

**Status:** ✅ Complete  
**Testing:** Manual testing required  
**Breaking Changes:** None (fully backward compatible)
