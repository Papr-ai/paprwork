# Smart Model Fallback System

**Added:** 2026-03-31

## Overview

When a job specifies an unavailable provider, the system now uses **capability-matched fallback** instead of blindly falling back to the default provider. The system analyzes the original model's characteristics (reasoning level, context window, speed, cost) and picks the best alternative from available providers.

## How It Works

### Simple Fallback (Before)

```
Job wants: openai/gpt-5.4 (advanced reasoning, 272K context)
User has: Claude, Ollama

Old Logic:
→ Fall back to first available provider
→ Uses: anthropic/claude-sonnet-4-6
```

### Smart Fallback (After)

```
Job wants: openai/gpt-5.4 (advanced reasoning, 272K context)
User has: Claude, Ollama

New Logic:
→ Analyze gpt-5.4 capabilities (advanced reasoning, 272K context, expensive)
→ Score each available provider:
   - Claude Sonnet 4.6: Score 170 (advanced reasoning ✓, 200K context ✓)
   - Ollama Qwen 3.5: Score 130 (medium reasoning ✗, 256K context ✓)
→ Pick best match: anthropic/claude-sonnet-4-6
```

## Capability Matching

### Model Profiles

Each model has a capability profile:

```typescript
"gpt-5.4": {
  reasoningLevel: "advanced",
  contextWindow: 272000,
  speed: "slow",
  cost: "expensive",
  specialties: ["reasoning", "computer-use", "complex-tasks"]
}

"claude-sonnet-4-6": {
  reasoningLevel: "advanced",
  contextWindow: 200000,
  speed: "medium",
  cost: "medium",
  specialties: ["reasoning", "writing", "analysis"]
}

"gemini-2.5-flash": {
  reasoningLevel: "medium",
  contextWindow: 1000000,
  speed: "fast",
  cost: "cheap",
  specialties: ["speed", "large-context", "multimodal"]
}
```

### Scoring Algorithm

```typescript
Score = 0

// Reasoning level (most important - 100 points)
if (same reasoning level) → +100
if (upgrade: medium→advanced) → +80
if (acceptable downgrade: advanced→medium) → +50

// Context window (30 points)
if (candidate >= original) → +30
else → +15

// Speed match (20 points)
if (same speed) → +20

// Cost consideration (15 points)
if (same cost) → +10
if (cheaper) → +15

// Specialty overlap (10 points each)
for each shared specialty → +10

Best score wins!
```

## Examples

### Example 1: GPT-5.4 → Claude Sonnet 4.6

```typescript
Job: provider: "openai", model: "gpt-5.4"
User has: Claude OAuth, Ollama

Original: gpt-5.4 (advanced, 272K, slow, expensive)

Scoring:
- claude-sonnet-4-6:
  + 100 (advanced reasoning ✓)
  + 15 (smaller context: 200K vs 272K)
  + 0 (speed: medium vs slow)
  + 15 (cheaper: medium vs expensive)
  + 10 (specialty: reasoning)
  = 140 points

- qwen3.5:latest:
  + 50 (downgrade: medium vs advanced)
  + 15 (smaller context: 256K vs 272K)
  + 0 (speed: medium vs slow)
  + 15 (cheaper: cheap vs expensive)
  + 0 (no specialty overlap)
  = 80 points

Winner: claude-sonnet-4-6 (140 > 80)

Console:
"[AgentService] Smart fallback: openai/gpt-5.4 → anthropic/claude-sonnet-4-6 (capability-matched)"
```

### Example 2: GPT-4o-mini → Gemini Flash

```typescript
Job: provider: "openai", model: "gpt-4o-mini"
User has: Google API key, Ollama

Original: gpt-4o-mini (basic, 128K, fast, cheap)

Scoring:
- gemini-2.5-flash:
  + 100 (basic→medium reasoning, upgrade!)
  + 30 (massive context: 1M vs 128K)
  + 20 (same speed: fast)
  + 10 (same cost: cheap)
  + 10 (specialty: speed)
  = 170 points

- qwen3.5:latest:
  + 80 (medium reasoning, upgrade)
  + 30 (large context: 256K vs 128K)
  + 0 (speed: medium vs fast)
  + 10 (same cost: cheap)
  + 0 (no specialty overlap)
  = 120 points

Winner: gemini-2.5-flash (170 > 120)

Console:
"[AgentService] Smart fallback: openai/gpt-4o-mini → google/gemini-2.5-flash (capability-matched)"
```

### Example 3: Claude Sonnet → GPT-5.2

```typescript
Job: provider: "anthropic", model: "claude-sonnet-4-6"
User has: OpenAI API key, Ollama

Original: claude-sonnet-4-6 (advanced, 200K, medium, medium)

Scoring:
- gpt-5.2:
  + 50 (downgrade: medium vs advanced)
  + 15 (smaller context: 128K vs 200K)
  + 20 (same speed: medium)
  + 10 (same cost: medium)
  + 0 (no specialty overlap)
  = 95 points

- qwen3.5:latest:
  + 50 (downgrade: medium vs advanced)
  + 30 (larger context: 256K vs 200K)
  + 20 (same speed: medium)
  + 15 (cheaper: cheap vs medium)
  + 0 (no specialty overlap)
  = 115 points

Winner: qwen3.5:latest (115 > 95)

Console:
"[AgentService] Smart fallback: anthropic/claude-sonnet-4-6 → ollama/qwen3.5:latest (capability-matched)"
```

## Model Catalog

### OpenAI Models

| Model | Reasoning | Context | Speed | Cost | Specialties |
|-------|-----------|---------|-------|------|-------------|
| gpt-5.4 | Advanced | 272K | Slow | Expensive | Reasoning, computer-use |
| gpt-5.4-pro | Advanced | 272K | Slow | Expensive | Multi-step, research |
| gpt-5.3-codex | Medium | 128K | Medium | Medium | Coding, structured |
| gpt-5.2 | Medium | 128K | Medium | Medium | General-purpose |
| gpt-4o | Medium | 128K | Fast | Medium | Speed, multimodal |
| gpt-4o-mini | Basic | 128K | Fast | Cheap | Speed, cost-effective |

### Anthropic Models

| Model | Reasoning | Context | Speed | Cost | Specialties |
|-------|-----------|---------|-------|------|-------------|
| claude-sonnet-4-6 | Advanced | 200K | Medium | Medium | Reasoning, writing |
| claude-sonnet-4 | Advanced | 200K | Medium | Medium | Computer-use, coding |
| claude-3-5-haiku | Basic | 200K | Fast | Cheap | Speed, cost-effective |

### Google Models

| Model | Reasoning | Context | Speed | Cost | Specialties |
|-------|-----------|---------|-------|------|-------------|
| gemini-2.5-flash | Medium | 1M | Fast | Cheap | Speed, large-context |
| gemini-2.5-pro | Advanced | 2M | Medium | Medium | Reasoning, massive-context |

### Ollama Models

| Model | Reasoning | Context | Speed | Cost | Specialties |
|-------|-----------|---------|-------|------|-------------|
| qwen3.5:latest | Medium | 256K | Medium | Cheap | Local, privacy, free |

## Task-Based Upgrades (Future)

The system can also detect task type from the job command and suggest better models:

```typescript
// Detect reasoning task
Job: "Analyze quarterly performance and identify trends"
→ Detected: reasoning task
→ Prefer: gpt-5.4, claude-sonnet-4-6, gemini-2.5-pro

// Detect coding task
Job: "Implement user authentication system"
→ Detected: coding task
→ Prefer: gpt-5.3-codex, claude-sonnet-4

// Detect writing task
Job: "Draft weekly newsletter"
→ Detected: writing task
→ Prefer: claude-sonnet-4-6, gpt-5.2
```

## Console Output

### Smart Fallback Success

```
[AgentService] No authentication found for specified provider (openai). Falling back...
[AgentService] Smart fallback: openai/gpt-5.4 → anthropic/claude-sonnet-4-6 (capability-matched)
[AgentService] Fallback score: 170 (reasoning: advanced, context: 200K)
```

### Unknown Model (Basic Fallback)

```
[AgentService] No authentication found for specified provider (openai). Falling back...
[AgentService] Unknown model capabilities for "gpt-5.0-alpha", using default provider
[AgentService] Falling back from openai to anthropic/claude-sonnet-4-6
```

### No Smart Fallback Available

```
[AgentService] No authentication found for specified provider (openai). Falling back...
[AgentService] Smart fallback: Failed to score providers (no capability data)
[AgentService] Falling back from openai to anthropic/claude-sonnet-4-6 (default)
```

## Implementation

### File Structure

```
src/gateway/utils/
├── defaultProvider.ts       # Basic provider resolution
└── smartFallback.ts         # NEW: Capability-matched fallback
    ├── MODEL_CAPABILITIES   # Model profiles
    ├── getBestFallbackModel() # Smart scoring
    ├── getUpgradeModelForTask() # Task-based upgrades
    └── detectTaskType()     # Task detection
```

### Integration

```typescript
// In AgentService.ts
if (authCheckFailed) {
  const { getBestFallbackModel } = await import("../utils/smartFallback.js");
  const available = await getAvailableProviders();
  
  const fallback = await getBestFallbackModel(
    originalProvider,
    originalModel,
    available
  );
  
  if (fallback) {
    provider = fallback.provider;
    model = fallback.model;
    console.log(`Smart fallback: ${originalProvider}/${originalModel} → ${provider}/${model}`);
  } else {
    // Basic fallback if smart matching fails
    const defaults = await getDefaultProviderAndModel();
    provider = defaults.provider;
    model = defaults.model;
  }
}
```

## Benefits

### For Users

✅ **Better job performance** - Gets closest match instead of random fallback  
✅ **Cost optimization** - Doesn't upgrade to expensive model unnecessarily  
✅ **Capability preservation** - Keeps reasoning level when possible  
✅ **Transparent** - Console shows why fallback was chosen  

### For Shared Configs

✅ **Team compatibility** - Same job works across different provider setups  
✅ **Migration friendly** - Switching providers preserves job behavior  
✅ **Quality consistency** - Similar models = similar results  

## Future Enhancements

### 1. Model Performance Tracking

```typescript
// Track actual performance of fallback choices
interface FallbackResult {
  originalModel: string;
  fallbackModel: string;
  jobSuccessRate: number;
  avgDuration: number;
  userSatisfaction: number;
}

// Learn which fallbacks work best
```

### 2. Cost-Aware Fallback

```typescript
// User preference: "Prefer cheaper models when falling back"
Settings → Jobs → Fallback Preference
○ Best capability match (current)
○ Cheapest available model
○ Fastest available model
```

### 3. Multi-Model Scoring

```typescript
// Consider all available models from a provider, not just default
Available in Anthropic:
- claude-sonnet-4-6 (default)
- claude-sonnet-4
- claude-3-5-haiku

Score all three, pick best match
```

### 4. Dynamic Model Updates

```typescript
// Fetch latest model capabilities from API
// Update MODEL_CAPABILITIES at runtime
// New models automatically supported
```

## Testing

```bash
# Test smart fallback with different scenarios
# Scenario 1: Advanced → Advanced
create_job({ provider: "openai", model: "gpt-5.4", ... })
# User has Claude
# Expected: claude-sonnet-4-6 (advanced reasoning match)

# Scenario 2: Fast → Fast
create_job({ provider: "openai", model: "gpt-4o-mini", ... })
# User has Gemini
# Expected: gemini-2.5-flash (fast match)

# Scenario 3: Large context → Large context
create_job({ provider: "google", model: "gemini-2.5-pro", ... })
# User has Claude, Ollama
# Expected: qwen3.5:latest (256K context better than Claude's 200K)
```

## Status

✅ **Core algorithm** - Implemented in `smartFallback.ts`  
✅ **Model profiles** - 15+ models cataloged with capabilities  
✅ **Integration** - Used in both job session methods  
✅ **Console logging** - Clear feedback on fallback choice  
⏳ **Task detection** - Code written, not yet integrated  
⏳ **Performance tracking** - Future enhancement  

---

**Summary:** The system now intelligently matches fallback models based on capabilities (reasoning, context, speed, cost) instead of blindly using the first available provider. This provides better job performance, cost optimization, and quality consistency across different provider configurations.
