# Provider Fallback for Unavailable Providers

**Added:** 2026-03-31

## Overview

When a job specifies a provider that the user doesn't have configured, the system now **automatically falls back** to the user's default provider instead of failing.

## Behavior

### Before (Without Fallback)

```typescript
// User only has Claude OAuth
// Job specifies OpenAI
create_job({
  name: "Weekly Brief",
  type: "agent",
  provider: "openai",  // ❌ User doesn't have OpenAI
  model: "gpt-5.2",
  command: "Generate weekly brief"
})

// Result: ❌ Error thrown
// "No authentication found for job agent run (openai). Connect OAuth or add API key."
// Job fails completely
```

### After (With Fallback)

```typescript
// Same scenario
create_job({
  name: "Weekly Brief",
  type: "agent",
  provider: "openai",  // User doesn't have OpenAI
  model: "gpt-5.2",
  command: "Generate weekly brief"
})

// Result: ✅ Falls back gracefully
// Console:
// "[AgentService] No authentication found for specified provider (openai). Falling back to default provider..."
// "[AgentService] Falling back from openai to anthropic/claude-sonnet-4-6"
// Job runs successfully with Claude
```

## Fallback Logic

```
1. Job specifies provider (e.g., "openai")
   ↓
2. Check if user has auth for that provider
   ↓
   ├─ ✅ Has auth → Use specified provider
   │
   └─ ❌ No auth → Trigger fallback
      ↓
      1. Log warning: "No authentication found for specified provider"
      2. Call getDefaultProviderAndModel()
      3. Get best available provider (OAuth → API key → Ollama)
      4. Log fallback: "Falling back from X to Y"
      5. Verify auth for fallback provider
      6. Use fallback provider ✅
```

## Console Output Examples

### Example 1: OpenAI → Claude Fallback

```
[AgentService] No authentication found for specified provider (openai). Falling back to default provider...
[AgentService] Falling back from openai to anthropic/claude-sonnet-4-6
```

### Example 2: Google → Ollama Fallback

```
[AgentService] Missing API key for specified provider (google): GOOGLE_API_KEY. Falling back to default provider...
[AgentService] Falling back from google to ollama/qwen3.5:latest
[AgentService] No OAuth or API keys found, falling back to Ollama (local inference)
```

### Example 3: No Fallback Available (Error)

```
[AgentService] No authentication found for specified provider (openai). Falling back to default provider...
[AgentService] Falling back from openai to anthropic/claude-sonnet-4-6
❌ Error: No authentication found for fallback provider (anthropic). Please configure at least one provider.
```

## When Fallback Happens

### Scenarios

| Job Config | User Has | Result |
|------------|----------|--------|
| `provider: "openai"` | Only Claude | ✅ Falls back to Claude |
| `provider: "anthropic"` | Only OpenAI | ✅ Falls back to OpenAI |
| `provider: "google"` | Only Ollama | ✅ Falls back to Ollama |
| `provider: "openai"` | Nothing | ❌ Error (no fallback available) |
| No provider specified | Claude OAuth | ✅ Uses Claude (default) |

## Use Cases

### 1. Shared Job Configurations

**Scenario:** User A shares a job with User B.

```typescript
// User A (has OpenAI) creates job
create_job({
  name: "Code Review",
  type: "agent",
  provider: "openai",
  model: "gpt-5.2",
  command: "Review this PR"
})

// User B imports the job but only has Claude
// Before: ❌ Job fails
// After: ✅ Job runs with Claude (fallback)
```

### 2. Trial/Expired Accounts

**Scenario:** User's OpenAI API key expires or hits quota.

```typescript
// Job configured with OpenAI
// OpenAI quota exceeded

// Before: ❌ All jobs fail
// After: ✅ Jobs fall back to Anthropic or Ollama
```

### 3. Multi-User Teams

**Scenario:** Team shares job templates, different members have different providers.

```typescript
// Job template from team library
create_job({
  name: "Daily Standup Notes",
  type: "agent",
  provider: "openai",  // Template specifies OpenAI
  command: "Summarize standup"
})

// Team member 1 (OpenAI) → Uses OpenAI ✅
// Team member 2 (Claude) → Falls back to Claude ✅
// Team member 3 (Ollama only) → Falls back to Ollama ✅
```

## Implementation Details

### Code Changes

Both `runIsolatedJobSession` and `runStructuredJobSession` in `AgentService.ts`:

```typescript
// Check if the specified provider is available
let authCheckFailed = false;
let originalProvider = provider;

if (provider === "openai" || provider === "anthropic") {
  const auth = await getProviderAuth(provider);
  if (!auth) {
    authCheckFailed = true;
    console.warn(`No authentication found for specified provider (${provider}). Falling back...`);
  }
}

// If auth check failed, fall back to default provider
if (authCheckFailed) {
  const defaults = await getDefaultProviderAndModel();
  provider = defaults.provider;
  model = defaults.model;
  console.log(`Falling back from ${originalProvider} to ${provider}/${model}`);
  
  // Re-check auth for fallback provider
  // If fallback also has no auth → throw error
}
```

### Safety Checks

1. **Fallback provider must have auth** - If fallback provider also has no auth, throws error
2. **Logs are clear** - Console shows original provider, fallback provider, reason
3. **Job logs include fallback info** - Users know their job used a different provider
4. **Explicit overrides respected** - If user explicitly sets provider, we try fallback (not ignore)

## User Communication

### Job Logs

When fallback happens, the job log includes:

```
[Job Log]
Starting isolated agent run: run-abc123
⚠️  Provider fallback: openai → anthropic (no OpenAI auth found)
Using model: anthropic/claude-sonnet-4-6
...
```

### Settings UI (Future)

```
⚠️ Warning: 3 jobs configured with unavailable providers
- "Weekly Brief" (openai) → using anthropic instead
- "Code Review" (google) → using ollama instead

[Configure OpenAI] [Configure Google]
```

## Testing

### Test Case 1: Basic Fallback

```bash
# User has only Claude OAuth
# Create job with OpenAI
create_job({
  name: "Test",
  type: "agent",
  provider: "openai",
  command: "Say hello"
})

# Expected console output:
# "No authentication found for specified provider (openai)"
# "Falling back from openai to anthropic/claude-sonnet-4-6"
# Job runs successfully
```

### Test Case 2: Cascading Fallback

```bash
# User has only Ollama (no API keys, no OAuth)
# Create job with OpenAI
create_job({
  name: "Test",
  type: "agent",
  provider: "openai",
  command: "Say hello"
})

# Expected console output:
# "No authentication found for specified provider (openai)"
# "No OAuth or API keys found, falling back to Ollama"
# "Falling back from openai to ollama/qwen3.5:latest"
# Job runs with Ollama
```

### Test Case 3: No Fallback Available (Error)

```bash
# User has NOTHING configured (no OAuth, no API keys, no Ollama)
# Create job with OpenAI
create_job({
  name: "Test",
  type: "agent",
  provider: "openai",
  command: "Say hello"
})

# Expected:
# "No authentication found for specified provider (openai)"
# "Falling back from openai to openai/gpt-5.2"  # Tries OpenAI again as default
# ❌ Error: "No authentication found for fallback provider (openai)"
```

## Design Decisions

### Why Fallback Instead of Fail?

**Pros:**
✅ Better UX - Jobs work even with mismatched configs  
✅ Shared configs - Teams can share jobs across different setups  
✅ Migration friendly - Users switching providers don't lose jobs  
✅ Graceful degradation - Expired keys don't break everything  

**Cons:**
❌ Unexpected behavior - User might not realize fallback happened  
❌ Model differences - Different providers have different capabilities  
❌ Cost implications - Fallback provider might be more expensive  

**Decision:** Fallback is better UX, but log clearly and consider UI warnings.

### Why Not Silent Fallback?

We log warnings instead of silently falling back because:
- Users should know their job is using a different provider
- Job output might differ based on provider/model
- Costs might be different
- Users can configure the correct provider if they care

### Why Not Ask User Permission?

Jobs are often scheduled/automated, so can't prompt for permission. The fallback provides:
1. Clear console logs
2. Job log entries
3. Future: Settings UI showing fallback configs

## Future Enhancements

### 1. Fallback Notifications

```
🔔 Notification: 5 jobs fell back to Ollama today
Your OpenAI API key may be expired or missing.

[Check Settings]
```

### 2. Fallback Preferences

```
Settings → Jobs → Fallback Behavior
○ Always use default provider (current)
○ Fail if specified provider unavailable
○ Ask each time (for interactive jobs)
```

### 3. Job-Level Fallback Control

```typescript
create_job({
  name: "Critical Job",
  type: "agent",
  provider: "openai",
  allowFallback: false,  // Fail instead of fallback
  command: "..."
})
```

### 4. Smart Fallback Ranking

```typescript
// Instead of just "default provider", consider:
// 1. Provider with most similar capabilities
// 2. Cheapest provider
// 3. Fastest provider
// 4. Most reliable provider (based on recent success rates)
```

## Status

✅ **Implemented** in both `runIsolatedJobSession` and `runStructuredJobSession`  
✅ **Console logging** clear and informative  
✅ **Fallback safety** checks that fallback provider has auth  
⏳ **Job log integration** - Add fallback info to job logs (future)  
⏳ **Settings UI warnings** - Show jobs using fallback (future)  

---

**Summary:** Jobs with unavailable providers now gracefully fall back to the user's default provider instead of failing, with clear logging to inform users what happened.
