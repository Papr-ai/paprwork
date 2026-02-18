# Model ID Validation - Complete Analysis

**Date:** 2026-02-17  
**Status:** ✅ Our model IDs are valid | ⚠️ Missing newest models (4.6)

---

## Key Finding: Our Model IDs Are CORRECT! ✅

### When User Picks "Claude Sonnet 4.5"

**Flow:**
1. UI: `model: "claude-sonnet-4-5"`
2. Gateway: `anthropic("claude-sonnet-4-5")`
3. Anthropic API: Resolves alias `claude-sonnet-4-5` → `claude-sonnet-4-5-20250929`
4. **Result:** ✅ Uses latest Claude Sonnet 4.5 (September 2025 release)

---

## Anthropic Model IDs from AI SDK (@ai-sdk/anthropic v3.0.41)

### Type Definition

```typescript
type AnthropicMessagesModelId = 
  'claude-haiku-4-5' |           // ✅ We use this
  'claude-haiku-4-5-20251001' | 
  'claude-sonnet-4-5' |          // ✅ We use this
  'claude-sonnet-4-5-20250929' | 
  'claude-opus-4-5' |            // ✅ We use this
  'claude-opus-4-5-20251101' | 
  'claude-opus-4-6' |            // ⚠️ NEW - We don't have this
  'claude-3-7-sonnet-20250219' | 
  'claude-3-7-sonnet-latest' | 
  'claude-3-5-haiku-20241022' | 
  'claude-3-5-haiku-latest' | 
  'claude-3-haiku-20240307' | 
  (string & {});  // ← Escape hatch: allows any string
```

**Key insight:** AI SDK uses **aliases** (`claude-sonnet-4-5`) that resolve to date versions (`claude-sonnet-4-5-20250929`).

---

## Type Safety Analysis

### Current Implementation

**Problem:** We use `model: string` everywhere, which accepts **any** string:

```typescript
// src/core/types/agents.ts
export interface AgentConfig {
  provider: Provider;  // ✅ Typed enum
  model: string;       // ❌ Any string accepted!
}
```

**Why no type errors?** AI SDK's type includes `(string & {})` which widens the type to accept any string while still providing autocomplete for known models.

### Would Stricter Types Help?

**Short answer: No, not much.**

Even if we used:
```typescript
model: AnthropicMessagesModelId;
```

TypeScript would still accept **any string** due to the `(string & {})` escape hatch.

**Why SDK does this:**
- Models change frequently
- New models get released
- Custom/fine-tuned models need support
- Shouldn't break existing code

---

## Missing Models: Claude 4.6 (Feb 2026)

### From Anthropic Official Docs (Feb 17, 2026)

**New models released:**

| Model | API ID | API Alias | Status |
|-------|--------|-----------|--------|
| Claude Sonnet 4.6 | claude-sonnet-4-6-YYYYMMDD | claude-sonnet-4-6 | ⚠️ We don't have |
| Claude Opus 4.6 | claude-opus-4-6-YYYYMMDD | claude-opus-4-6 | ✅ In SDK type |

**From search results:** "Claude Sonnet 4.6 released February 2026, now default for Claude.ai"

### Our Current Models (Valid but Not Latest)

| Model | Status | API Resolution |
|-------|--------|----------------|
| claude-haiku-4-5 | ✅ Valid | → claude-haiku-4-5-20251001 |
| claude-sonnet-4-5 | ✅ Valid | → claude-sonnet-4-5-20250929 |
| claude-opus-4-5 | ✅ Valid | → claude-opus-4-5-20251101 |
| claude-opus-4-6 | ⚠️ In SDK, not in our UI | Latest Opus |
| claude-sonnet-4-6 | ⚠️ Not in SDK yet | Latest Sonnet |

---

## Recommendation

### 1. Add Claude 4.6 Models to UI

**File:** `ui/constants/models.ts`

```typescript
// Add after claude-opus-4-5-thinking
{
  id: "claude-opus-4-6",
  name: "Claude Opus 4.6",
  provider: "anthropic",
  description: "Latest flagship model with exceptional coding and reasoning (Feb 2026)",
  group: "Anthropic",
  supportsThinking: true,
  defaultThinkingBudget: 32000,
  maxTokens: 128000,  // New: 128K output tokens
  requiresApiKey: "ANTHROPIC_API_KEY",
},
{
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  provider: "anthropic",
  description: "Latest balanced model, now default on Claude.ai (Feb 2026)",
  group: "Anthropic",
  supportsThinking: true,
  defaultThinkingBudget: 16000,
  maxTokens: 64000,
  requiresApiKey: "ANTHROPIC_API_KEY",
},
```

### 2. Keep `model: string` for Flexibility

Don't change to stricter types - the AI SDK itself uses escape hatches, so strict typing wouldn't help.

### 3. Add JSDoc Comments

```typescript
export interface AgentConfig {
  provider: Provider;
  
  /**
   * Model ID to use for this agent
   * 
   * Valid Anthropic models: claude-sonnet-4-6, claude-opus-4-6, claude-sonnet-4-5, etc.
   * Valid OpenAI models: gpt-5-2, gpt-5-mini, gpt-5-2-codex, etc.
   * Valid Google models: gemini-2-5-flash, gemini-3-pro-preview, etc.
   * 
   * See ui/constants/models.ts for complete list
   */
  model: string;
}
```

### 4. Add Runtime Validation (Optional)

If we want stronger guarantees, add validation in `ChatSessionManager`:

```typescript
// Validate model exists in our supported list
const validModels = CHAT_MODELS.map(m => m.id);
if (!validModels.includes(config.model)) {
  console.warn(`Unknown model ID: ${config.model}. Proceeding anyway.`);
}
```

---

## Summary

### ✅ Current Model IDs Are Valid

All our Claude model IDs are **correct aliases** that work with Anthropic API:
- `claude-sonnet-4-5` ✅
- `claude-opus-4-5` ✅
- `claude-haiku-4-5` ✅
- `claude-opus-4-5-thinking` ✅ (if thinking is enabled via options)

### ⚠️ Type Safety Status

- **No type errors possible** - AI SDK uses `(string & {})` type widening
- **No autocomplete** - We use `model: string` instead of SDK types
- **Runtime validation** - Only way to catch invalid models

### 🔄 Action Items

1. **Add Claude 4.6 models** to `ui/constants/models.ts`
2. **Update ModelFallback.ts** with 4.6 models
3. **Consider JSDoc** for better developer experience
4. **Optional: Runtime validation** for typo detection

---

## When User Picks Claude Sonnet 4.5

**Answer:** Gets `claude-sonnet-4-5-20250929` (Sept 2025 Sonnet 4.5 release)  
**Is this correct?** ✅ Yes! Valid alias, works perfectly.  
**Latest model?** ⚠️ No, Claude Sonnet 4.6 is newer (Feb 2026).
