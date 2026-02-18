# Type Safety Gap: Model IDs Not Type-Checked

**Date:** 2026-02-17  
**Issue:** Model IDs are `string` type, not validated against AI SDK's typed model IDs  
**Status:** 🔴 No type safety for model IDs

---

## Current State: ❌ No Type Checking

### Our Code

**File:** `src/core/types/agents.ts`

```typescript
export interface AgentConfig {
  provider: Provider;              // ✅ Typed: "anthropic" | "openai" | "google"
  model: string;                   // ❌ Any string! No validation!
  systemPrompt: string;
  // ...
}
```

**File:** `src/gateway/services/ChatSessionManager.ts`

```typescript
case 'anthropic':
  model = anthropic(config.model);  // ← config.model is just `string`
  break;
```

**Result:** TypeScript accepts **ANY** string as a model ID, including:
- ❌ `"claude-opus-4.5"` (wrong format, dots)
- ❌ `"claude-3-opus"` (old model)
- ❌ `"gpt-4o"` (wrong provider!)
- ❌ `"banana"` (nonsense)

**No compile-time error!** Only runtime API failures.

---

## AI SDK Has Typed Model IDs!

### Available in @ai-sdk/anthropic v3.0.41

**File:** `node_modules/@ai-sdk/anthropic/dist/index.d.ts`

```typescript
type AnthropicMessagesModelId = 
  'claude-3-5-haiku-20241022' | 
  'claude-3-5-haiku-latest' | 
  'claude-3-7-sonnet-20250219' | 
  'claude-3-7-sonnet-latest' | 
  'claude-3-haiku-20240307' | 
  'claude-haiku-4-5-20251001' | 
  'claude-haiku-4-5' |           // ✅ Valid alias
  'claude-opus-4-0' | 
  'claude-opus-4-1-20250805' | 
  'claude-opus-4-1' | 
  'claude-opus-4-20250514' | 
  'claude-opus-4-5' |             // ✅ Valid alias
  'claude-opus-4-5-20251101' | 
  'claude-sonnet-4-0' | 
  'claude-sonnet-4-20250514' | 
  'claude-sonnet-4-5-20250929' | 
  'claude-sonnet-4-5' |           // ✅ Valid alias
  'claude-opus-4-6' |             // ✅ NEW (Feb 2026)
  (string & {});                   // ← Type widening escape hatch
```

**Interface:**
```typescript
interface AnthropicProvider {
  (modelId: AnthropicMessagesModelId): LanguageModelV3;  // ← Expects typed ID!
  languageModel(modelId: AnthropicMessagesModelId): LanguageModelV3;
  // ...
}
```

**The SDK HAS types**, but we're not using them!

---

## Why We're Not Getting Type Errors

### Reason: `(string & {})` Type Widening

```typescript
type AnthropicMessagesModelId = 
  'claude-sonnet-4-5' | 
  'claude-opus-4-5' | 
  (string & {});  // ← This allows ANY string!
```

The `(string & {})` is a TypeScript pattern that:
- Shows suggestions for the literal types
- But still accepts any string
- Gives autocomplete without enforcing validation

**Benefit:** Flexibility for new models  
**Cost:** No compile-time validation

---

## Similar Pattern in OpenAI and Google SDKs

All AI SDK providers likely use the same pattern:
- Type suggestions for known models
- Escape hatch for custom/new models
- No strict enforcement

**Why:** Models change frequently, SDK shouldn't break existing code.

---

## What This Means for Us

### ✅ Good News

1. **Our model IDs are valid:**
   - `claude-sonnet-4-5` ✅ (in type union)
   - `claude-opus-4-5` ✅ (in type union)
   - `claude-haiku-4-5` ✅ (in type union)

2. **SDK accepts them without errors**

3. **We're using correct aliases** (not date-based versions)

### ❌ Bad News

1. **No compile-time validation:**
   - Typos won't be caught: `"claude-opus-4.5"` (dots)
   - Wrong models won't error: `"gpt-4o"` on Anthropic provider

2. **IntelliSense/autocomplete not working:**
   - Because `model: string` instead of `model: AnthropicMessagesModelId`

---

## Should We Add Stricter Types?

### Option 1: Use AI SDK Types ⭐ RECOMMENDED

**Pros:**
- ✅ Autocomplete in IDE
- ✅ Type errors for invalid models
- ✅ Always up-to-date with SDK

**Cons:**
- ⚠️ Still has `(string & {})` escape hatch (not fully strict)
- ⚠️ Need separate types per provider

**Implementation:**

```typescript
// src/core/types/agents.ts
import type { AnthropicMessagesModelId } from '@ai-sdk/anthropic';
import type { OpenAIChatModelId } from '@ai-sdk/openai';
import type { GoogleGenerativeAIModelId } from '@ai-sdk/google';

export type AnthropicModel = AnthropicMessagesModelId;
export type OpenAIModel = OpenAIChatModelId | string;  // OpenAI has custom variants
export type GoogleModel = GoogleGenerativeAIModelId;

export interface AgentConfig {
  provider: Provider;
  model: string;  // Keep as string for flexibility, or...
  // OR use discriminated union:
  // model: Provider extends 'anthropic' ? AnthropicModel : 
  //        Provider extends 'openai' ? OpenAIModel : GoogleModel;
  systemPrompt: string;
  // ...
}
```

### Option 2: Define Our Own Model Union

**Pros:**
- ✅ Full control over allowed models
- ✅ Can match our UI exactly

**Cons:**
- ❌ Manual maintenance when models change
- ❌ Can get out of sync with SDK

**Implementation:**

```typescript
// src/core/types/models.ts
export type ClaudeModel = 
  | "claude-haiku-4-5"
  | "claude-sonnet-4-5"
  | "claude-opus-4-5"
  | "claude-opus-4-5-thinking"
  | "claude-opus-4-6";

export type GPTModel = 
  | "gpt-5-mini"
  | "gpt-5-2"
  | "gpt-5-2-low"
  | "gpt-5-2-high"
  | "gpt-5-2-xhigh"
  | "gpt-5-2-codex";

export type GeminiModel = 
  | "gemini-2-5-flash"
  | "gemini-2-5-flash-lite"
  | "gemini-3-pro-preview"
  | "gemini-3-flash-preview";

export type ModelId = ClaudeModel | GPTModel | GeminiModel;

// Then in agents.ts
export interface AgentConfig {
  provider: Provider;
  model: ModelId;  // ← Type-safe!
  // ...
}
```

### Option 3: Keep Current (String)

**Pros:**
- ✅ Maximum flexibility
- ✅ No maintenance
- ✅ Works with any model (future-proof)

**Cons:**
- ❌ No type safety
- ❌ No autocomplete
- ❌ Typos only caught at runtime

---

## Recommendation: Hybrid Approach

1. **Import AI SDK types** for documentation
2. **Keep `model: string`** for flexibility
3. **Add JSDoc comments** with valid values
4. **Validate at runtime** if needed

```typescript
import type { AnthropicMessagesModelId } from '@ai-sdk/anthropic';

export interface AgentConfig {
  provider: Provider;
  
  /**
   * Model ID to use for this agent
   * 
   * Anthropic: claude-sonnet-4-5, claude-opus-4-5, claude-haiku-4-5, etc.
   * OpenAI: gpt-5-mini, gpt-5-2, gpt-5-2-codex, etc.
   * Google: gemini-2-5-flash, gemini-3-pro-preview, etc.
   * 
   * @see AnthropicMessagesModelId for Anthropic models
   */
  model: string;
  
  systemPrompt: string;
  // ...
}
```

**Benefits:**
- ✅ Flexibility preserved
- ✅ Documentation in IDE
- ✅ Easy to understand
- ✅ No breaking changes

---

## Verification: Our Models Are Valid!

From Anthropic's official docs and AI SDK types:

✅ `claude-sonnet-4-5` - Valid alias (resolves to `claude-sonnet-4-5-20250929`)  
✅ `claude-opus-4-5` - Valid alias (resolves to `claude-opus-4-5-20251101`)  
✅ `claude-haiku-4-5` - Valid alias (resolves to `claude-haiku-4-5-20251001`)

**When user picks "Claude Sonnet 4.5" in UI:**
1. Model ID: `"claude-sonnet-4-5"`
2. API receives: `"claude-sonnet-4-5"`
3. Anthropic resolves to: `claude-sonnet-4-5-20250929` (latest Sonnet 4.5)

---

## Summary

### Current State
- ❌ `model: string` (no type safety)
- ❌ No autocomplete for valid model IDs
- ❌ Typos only caught at runtime
- ✅ Maximum flexibility

### AI SDK Provides
- ✅ `AnthropicMessagesModelId` typed union
- ⚠️ Has `(string & {})` escape hatch (not fully strict)
- ✅ Our model aliases are valid

### Recommendation
Keep `model: string` but add JSDoc comments for documentation. The `(string & {})` escape hatch means strict typing wouldn't help much anyway.

### Missing Models in SDK
- ⚠️ `claude-opus-4-6` is in SDK but we don't have it
- ⚠️ `claude-sonnet-4-6` exists (Feb 2026 release) but we don't have it
