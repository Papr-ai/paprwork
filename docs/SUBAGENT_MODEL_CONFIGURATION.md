# Sub-Agent Model Configuration

**Date:** 2026-02-17  
**Topic:** How sub-agent models are configured and can be changed

---

## Default Model for Sub-Agents

### When Creating Sub-Agents

**Default:** `gpt-5-mini` (OpenAI)

When a sub-agent is created via `create_sub_agent`, the `model` and `provider` fields are **optional**:

```typescript
// From src/core/tools/delegation.ts
const createSubAgentSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  systemPrompt: z.string().min(1),
  provider: z.enum(["anthropic", "openai", "google"]).optional(),  // ✅ optional
  model: z.string().min(1).optional(),                              // ✅ optional
  allowedToolIds: z.array(z.string().min(1)).optional(),
  // ... other fields
});
```

### Built-in Default Sub-Agents

**File:** `src/gateway/services/SubAgentService.ts`

Two default sub-agents are created on first run:

```typescript
const DEFAULT_SUB_AGENTS = [
  {
    id: "research-specialist",
    name: "Research Specialist",
    provider: "openai",
    model: "gpt-5-mini",  // ← Default
    // ...
  },
  {
    id: "implementation-specialist",
    name: "Implementation Specialist",
    provider: "openai",
    model: "gpt-5-mini",  // ← Default
    // ...
  },
];
```

**Why gpt-5-mini?**
- Fast execution
- Cost-effective for high-volume operations
- Sufficient for most sub-agent tasks (research, implementation, data processing)
- Lower latency than larger models

---

## Can the Model Be Changed?

### ✅ Yes - Multiple Ways to Change Models

### 1. Main Agent Can Specify Model During Creation

The main agent can specify a different model when creating a sub-agent:

```javascript
// Main agent calls this tool
create_sub_agent({
  name: "Advanced Researcher",
  description: "Deep research requiring complex reasoning",
  systemPrompt: "You are an expert researcher...",
  provider: "anthropic",              // ✅ Can specify provider
  model: "claude-opus-4-5-thinking",  // ✅ Can specify model
  allowedToolIds: ["bash", "read_file", "search_files"]
})
```

**Result:** Sub-agent uses `claude-opus-4-5-thinking` instead of default `gpt-5-mini`.

---

### 2. Main Agent Can Update Existing Sub-Agent

The main agent can modify an existing sub-agent's model:

```javascript
// Update existing sub-agent to use different model
create_sub_agent({
  id: "research-specialist",  // ← Existing ID triggers update
  name: "Research Specialist",
  description: "Investigates complex topics",
  systemPrompt: "You are a research specialist...",
  provider: "anthropic",
  model: "claude-sonnet-4-5",  // ✅ Changed from gpt-5-mini
  allowedToolIds: ["bash", "read_file", "search_files"]
})
```

**Result:** Existing sub-agent now uses `claude-sonnet-4-5` for all future runs.

---

### 3. User Can Change Model via UI

**Location:** Agents page in UI

**File:** `ui/components/Agents/AgentsView.tsx`

Users can:
1. View all sub-agents
2. Edit sub-agent profiles
3. Change `provider` and `model` fields
4. Save changes

**Available models in dropdown:**
```typescript
const modelOptions = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "claude-opus-4-5-thinking",
  "gpt-5-2",
  "gpt-5-2-low",
  "gpt-5-2-high",
  "gpt-5-2-xhigh",
  "gpt-5-2-codex",
  "gpt-5-mini",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2-5-flash",
  "gemini-2-5-flash-lite",
];
```

---

## How Model is Determined at Runtime

### When Sub-Agent Runs

**File:** `src/gateway/services/jobs/executors/AgentJobExecutor.ts`

```typescript
// 1. Load sub-agent profile
const profile = await subAgentService.getAgent(subAgentId);

// 2. Extract model from profile (or undefined if not set)
provider = profile.provider;  // May be undefined
model = profile.model;        // May be undefined

// 3. Pass to AgentService (which has fallback logic)
await agentService.runIsolatedJobSession({
  jobId: job.id,
  runId: runId,
  prompt: prompt,
  provider: provider,    // ← From profile (or undefined)
  model: model,          // ← From profile (or undefined)
  allowedToolIds: profile.allowedToolIds,
  maxTurns: job.maxTurns,
});
```

### Fallback Logic (if model not specified)

**File:** `src/gateway/services/AgentService.ts`

```typescript
// If model/provider not specified in profile, use defaults:
const defaultModelByProvider: Record<Provider, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2-5-flash",
};

// Default provider if none specified
const provider = input.provider ?? "openai";
const model = input.model ?? defaultModelByProvider[provider];
```

**Result:** Even if sub-agent doesn't specify model, it gets a sensible default.

---

## Model Selection Strategy

### When Should Sub-Agents Use Different Models?

#### Use `gpt-5-mini` (default) for:
- ✅ Simple research tasks
- ✅ Data extraction
- ✅ Basic file processing
- ✅ High-volume operations
- ✅ Cost-sensitive workflows

#### Use `claude-sonnet-4-5` for:
- ✅ Complex reasoning
- ✅ Multi-step analysis
- ✅ Code review
- ✅ Writing quality content

#### Use `claude-opus-4-5-thinking` for:
- ✅ Deep research
- ✅ Strategic planning
- ✅ Complex problem-solving
- ✅ Maximum reasoning capability

#### Use `gpt-5-2-codex` for:
- ✅ Code generation
- ✅ Code refactoring
- ✅ Technical implementation

---

## System Prompt Guidance

**From SystemPrompt.ts:**

### Sub-Agent Creation Requirements

When creating sub-agents with `create_sub_agent`, you can optionally specify `model` and `provider`.

**If not specified:** Defaults to `openai` / `gpt-5-mini`

**Example 1: Use defaults**
```javascript
create_sub_agent({
  name: "data-processor",
  description: "Processes SQLite data",
  systemPrompt: "Read from data.db and analyze..."
  // provider defaults to "openai"
  // model defaults to "gpt-5-mini"
})
```

**Example 2: Custom model for reasoning**
```javascript
create_sub_agent({
  name: "researcher",
  systemPrompt: "Research complex topics...",
  provider: "anthropic",
  model: "claude-opus-4-5-thinking"  // ← Higher reasoning capability
})
```

**Example 3: Cost-optimized for high volume**
```javascript
create_sub_agent({
  name: "data-validator",
  systemPrompt: "Validate data entries...",
  provider: "openai",
  model: "gpt-5-mini"  // ← Explicit, cost-effective
})
```

---

## Persistence

### Where Sub-Agent Profiles Are Stored

**File:** `~/PAPR/data/subagents.json`

```json
[
  {
    "id": "research-specialist",
    "name": "Research Specialist",
    "provider": "openai",
    "model": "gpt-5-mini",
    "allowedToolIds": ["bash", "read_file", "search_files"],
    "createdAt": "2026-02-17T...",
    "updatedAt": "2026-02-17T...",
    "runCount": 5
  }
]
```

**Changes persist across app restarts.**

---

## UI Model Selection

### Agents View

**Component:** `ui/components/Agents/AgentsView.tsx`

Users can:
1. Click on a sub-agent to edit
2. Select from dropdown of available models
3. Change provider (Anthropic/OpenAI/Google)
4. Save changes

**Model dropdown shows all supported models** including reasoning variants for each provider.

---

## Summary

### Default Model
✅ **`gpt-5-mini` (OpenAI)** - Fast, cost-effective, sufficient for most tasks

### Can Be Changed?
✅ **Yes, in 3 ways:**
1. Main agent specifies during `create_sub_agent`
2. Main agent updates via `create_sub_agent` with existing ID
3. User edits via Agents UI

### Model Inheritance
- Model comes from **sub-agent profile**
- If not set in profile → **falls back to provider default**
- Different runs of same sub-agent → **use same model** (unless profile updated)

### Per-Run Override?
❌ **No** - Model cannot be overridden per delegation run. Model is set at the **profile level**, not run level.

**If you need different models:**
- Create separate sub-agent profiles with different models
- Or update the profile before delegating

---

## Example Workflow

```javascript
// 1. Main agent creates specialized sub-agent with powerful model
create_sub_agent({
  name: "deep-researcher",
  description: "Complex research requiring extended thinking",
  systemPrompt: "You are an expert researcher...",
  provider: "anthropic",
  model: "claude-opus-4-5-thinking",  // ← Powerful model
  allowedToolIds: ["bash", "read_file", "search_files"]
})

// 2. Delegate task to this sub-agent
delegate_task({
  task: "Research quantum computing applications",
  useAgentId: "deep-researcher",
  reportChatId: "current-chat-id"
})

// 3. Sub-agent runs with claude-opus-4-5-thinking
// (inherits from profile, no per-run override)
```

---

## Best Practices

1. **Use defaults for most tasks** - `gpt-5-mini` is fast and capable
2. **Upgrade models for complex tasks** - Use Claude Opus or GPT-5.2 for reasoning-heavy work
3. **Create specialized profiles** - Different sub-agents for different complexity levels
4. **Monitor costs** - Larger models are more expensive, use strategically
5. **Name clearly** - Include model capability in sub-agent name (e.g., "fast-researcher" vs "deep-researcher")

---

**Questions?**
- Main agent can change models ✅
- User can change models via UI ✅
- Per-run override ❌ (use separate profiles instead)
- Default: `gpt-5-mini` ✅
