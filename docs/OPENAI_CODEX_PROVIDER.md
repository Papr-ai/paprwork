# OpenAI Codex Provider Implementation

**Date:** 2026-02-20  
**Status:** ✅ Complete

## Overview

Added support for OpenAI Codex subscription models via ChatGPT OAuth as a separate `openai-codex` provider. This allows users with ChatGPT Plus/Pro/Business/Enterprise subscriptions to use GPT-5.3-Codex without Platform API keys.

## Key Distinctions

| Feature | `openai` Provider | `openai-codex` Provider |
|---------|-------------------|-------------------------|
| **Auth Method** | API Key (Platform) | OAuth (ChatGPT Subscription) |
| **Models** | `gpt-5.1-codex`, `gpt-5.2-codex`, `gpt-5-mini` | `gpt-5.3-codex` |
| **Endpoint** | `/v1/responses` (Platform API) | `/v1/responses` (via OAuth token) |
| **Billing** | Usage-based (pay per token) | Subscription-based (Plus/Pro/Business/Enterprise) |
| **Access** | OpenAI Platform account | ChatGPT subscription |

## Implementation Details

### 1. New Provider Type

**File:** `src/core/types/agents.ts`

```typescript
export type Provider = "anthropic" | "openai" | "openai-codex" | "google";
```

### 2. Model Configuration

**File:** `ui/constants/models.ts`

Added `gpt-5.3-codex` model:

```typescript
{
  id: "gpt-5.3-codex",
  name: "GPT-5.3 Codex (ChatGPT Plus/Pro)",
  provider: "openai-codex",
  description: "Latest Codex model via ChatGPT subscription (OAuth)",
  group: "OpenAI Codex",
  supportsThinking: true,
  reasoning: { effort: "medium" },
  maxTokens: 16384,
  requiresApiKey: "OPENAI_OAUTH",
}
```

### 3. Language Model Creation

**File:** `src/gateway/services/AgentService.ts` → `createLanguageModel()`

```typescript
case "openai-codex": {
  // OpenAI Codex uses the same SDK but with OAuth token
  // The token is already set in OPENAI_API_KEY by setProviderAuth
  const { openai } = await import("@ai-sdk/openai");
  // Use responses API for Codex models (gpt-5.3-codex)
  return openai.responses(modelId) as LanguageModel;
}
```

### 4. Authentication Handling

**File:** `src/gateway/services/AgentService.ts` → `setProviderAuth()`

The `openai-codex` provider maps to `openai` for OAuth lookup (they share the same OAuth token), then sets `OPENAI_API_KEY` with the OAuth token:

```typescript
// Map openai-codex to openai for OAuth lookup (they share the same OAuth token)
const authProvider = provider === "openai-codex" ? "openai" : provider;
const auth = await getProviderAuth(authProvider);

if (auth && auth.type === "oauth") {
  switch (provider) {
    case "openai":
    case "openai-codex":
      process.env.OPENAI_API_KEY = auth.token;
      console.log(`[AgentService] Using OpenAI OAuth token for ${provider}`);
      break;
  }
}
```

### 5. Model Fallback Support

**File:** `src/core/agents/ModelFallback.ts`

Added `openai-codex` entry with `gpt-5.3-codex` model info.

### 6. Job Executor Support

**File:** `src/gateway/services/jobs/executors/AgentJobExecutor.ts`

Updated provider type to include `"openai-codex"`.

## How It Works

1. **User connects via OAuth** (Settings → API Keys → ChatGPT OAuth → Connect)
2. **OAuth token stored** in `OAuthTokenStorage`
3. **Token synced** to `CustomKeysStorage` as `OPENAI_API_KEY` (with metadata `source: "oauth"`)
4. **User selects `gpt-5.3-codex`** model (provider: `openai-codex`)
5. **AgentService** maps `openai-codex` → `openai` for auth lookup
6. **Gets OAuth token** from keyResolver (prefers OAuth over API key)
7. **Sets `OPENAI_API_KEY`** with OAuth token
8. **Creates model** using `openai.responses("gpt-5.3-codex")`
9. **AI SDK** makes requests to `/v1/responses` with OAuth token

## Benefits

- ✅ **No Platform API key needed** for ChatGPT Plus/Pro users
- ✅ **Access to GPT-5.3-Codex** (latest Codex model)
- ✅ **Subscription billing** (no usage fees)
- ✅ **Auto-refresh** of OAuth tokens (handled by existing OAuth infrastructure)
- ✅ **Priority access** - OAuth tokens preferred over API keys

## Usage

### Prerequisites

- ChatGPT Plus, Pro, Business, or Enterprise subscription
- OAuth connection in Paprwork Settings

### Selecting the Model

In the UI model selector, choose:
- **Group:** "OpenAI Codex"
- **Model:** "GPT-5.3 Codex (ChatGPT Plus/Pro)"

### For Jobs/Scripts

```typescript
{
  provider: "openai-codex",
  model: "gpt-5.3-codex"
}
```

## Comparison: API Key vs OAuth

### When to use `openai` provider (API Key)
- You have OpenAI Platform API access
- You want to use `gpt-5.1-codex` or `gpt-5.2-codex`
- You prefer usage-based billing
- You need organization/project-level access

### When to use `openai-codex` provider (OAuth)
- You have ChatGPT Plus/Pro/Business/Enterprise
- You want to use `gpt-5.3-codex`
- You prefer subscription billing (no usage fees)
- You don't have Platform API access

## Troubleshooting

### "Missing scopes: api.responses.write" error

This error occurs when trying to use OAuth with the `openai` provider (not `openai-codex`). 

**Solution:** Use `openai-codex` provider with `gpt-5.3-codex` model, OR use an API key with the `openai` provider.

### OAuth connection successful but model doesn't work

Make sure you're using the `openai-codex` provider, not `openai`. The `openai` provider expects Platform API keys, while `openai-codex` uses OAuth tokens.

## Files Changed

- `src/core/types/agents.ts` - Added `openai-codex` to Provider type
- `ui/constants/models.ts` - Added `gpt-5.3-codex` model and updated AIModel interface
- `src/gateway/services/AgentService.ts` - Added `openai-codex` case in `createLanguageModel` and `setProviderAuth`
- `src/core/agents/ModelFallback.ts` - Added `openai-codex` models
- `src/gateway/services/jobs/executors/AgentJobExecutor.ts` - Added `openai-codex` to provider type

## Related Docs

- [OAuth Implementation](./OAUTH_TESTING_GUIDE.md)
- [OpenClaw OpenAI OAuth Code](../.cursor/plans/openclaw_openai_oauth_code_689653fd.plan.md)
- [OpenAI Provider Docs](https://docs.openclaw.ai/providers/openai)
