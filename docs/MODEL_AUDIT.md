# Model IDs Audit

**Date:** 2026-02-17  
**Status:** 🔴 Multiple inconsistencies found

---

## Current Correct Models (from ui/constants/models.ts)

### Anthropic Claude
- ✅ `claude-haiku-4-5`
- ✅ `claude-sonnet-4-5`
- ✅ `claude-opus-4-5`
- ✅ `claude-opus-4-5-thinking`

### OpenAI GPT-5
- ✅ `gpt-5-2` (base)
- ✅ `gpt-5-2-low` (low reasoning)
- ✅ `gpt-5-2-high` (high reasoning)
- ✅ `gpt-5-2-xhigh` (extra high reasoning)
- ✅ `gpt-5-2-codex` (code specialist)
- ✅ `gpt-5-mini` (NOT in constants/models.ts but used in AgentService)

### Google Gemini
- ✅ `gemini-3-pro-preview`
- ✅ `gemini-3-flash-preview`
- ✅ `gemini-2-5-flash`
- ✅ `gemini-2-5-flash-lite`

---

## 🔴 Critical Issues Found

### 1. AgentsView.tsx - WRONG FORMAT (dots instead of dashes)

**File:** `ui/components/Agents/AgentsView.tsx`

```typescript
// ❌ WRONG - uses dots (4.5) instead of dashes (4-5)
const modelOptions = [
  "claude-haiku-4.5",      // ❌ should be "claude-haiku-4-5"
  "claude-sonnet-4.5",     // ❌ should be "claude-sonnet-4-5"
  "claude-opus-4.5",       // ❌ should be "claude-opus-4-5"
  "claude-opus-4.5-thinking", // ❌ should be "claude-opus-4-5-thinking"
  "gpt-5.2",               // ❌ should be "gpt-5-2"
  "gpt-5.2-thinking",      // ❌ should be "gpt-5-2-thinking"
  "gpt-5-mini",            // ✅ correct
  "gpt-5-nano",            // ⚠️  doesn't exist in models.ts!
  "gpt-5.2-codex",         // ❌ should be "gpt-5-2-codex"
  "gemini-2.0-flash",      // ⚠️  should be "gemini-2-5-flash"?
];
```

**Impact:** HIGH - Users can't select correct models in Agents UI!

---

### 2. Test Files - OLD MODELS (GPT-4/Claude 3.5 era)

#### llm-streaming-from-storage.ts
```typescript
// ❌ OLD MODELS
model: "claude-sonnet-4-20250514",  // API version format
model: "gpt-4o-mini",               // GPT-4 era
model: "gemini-2.0-flash-exp",      // experimental suffix
```

#### chat-session-manager.test.ts
```typescript
// ❌ OLD MODELS
model: 'claude-3-5-sonnet-20241022',  // Claude 3.5 era
model: 'claude-3-7-sonnet-20250219',  // doesn't exist!
model: 'gpt-5.2-turbo',               // doesn't exist!
model: 'gemini-2.0-flash-exp',
```

#### agent-max-tokens.test.ts
```typescript
// ❌ OLD MODELS
model: "gpt-4o",
model: "gemini-2.0-flash-exp",
```

#### Multiple integration/test files using:
- `claude-3-5-sonnet-20241022` (13 occurrences)
- `gpt-4o-mini` (5 occurrences)
- `gpt-4` (2 occurrences)

**Impact:** MEDIUM - Tests work but use outdated models

---

### 3. AgentService.ts - FALLBACK MODELS WRONG

**File:** `src/gateway/services/AgentService.ts`

```typescript
// Line 667-669: Default fallback models
openai: "gpt-5-mini",              // ✅ correct (but not in models.ts!)
anthropic: "claude-3-5-sonnet-latest", // ❌ Claude 3.5 era
google: "gemini-2.5-flash",        // ✅ correct
```

**Impact:** HIGH - Fallback to wrong model on API key fetch failure

---

### 4. SubAgentService.ts - DEFAULT MODEL

**File:** `src/gateway/services/SubAgentService.ts`

```typescript
// Lines 40, 55
model: "gpt-5-mini",  // ✅ correct (but not in models.ts!)
```

**Impact:** LOW - Works but model not documented

---

### 5. ModelFallback.ts - FIXED BUT UNUSED

**Status:** ✅ Fixed in previous commit, but file is not used anywhere

---

## 🟡 Model ID Format Issues

### Inconsistent Delimiter Usage

**Problem:** Some files use dots (`.`) where dashes (`-`) should be used:

```
❌ claude-haiku-4.5     → ✅ claude-haiku-4-5
❌ gpt-5.2              → ✅ gpt-5-2
❌ gemini-2.0-flash     → ❌ gemini-2-5-flash (also wrong version)
```

**Root Cause:** Mixing notation styles (semantic versioning vs model IDs)

---

## 🟢 Missing Model: gpt-5-mini

**Issue:** `gpt-5-mini` is used in multiple places but NOT defined in `ui/constants/models.ts`!

**Used in:**
- `AgentService.ts` (line 667) - default fallback
- `SubAgentService.ts` (lines 40, 55) - default sub-agent model
- `AgentsView.tsx` (line 14, 27, 138, 276) - UI dropdown and default

**Should be added to models.ts!**

---

## 🟠 Model: gpt-5-nano

**Issue:** `gpt-5-nano` appears in `AgentsView.tsx` but doesn't exist anywhere else!

**Question:** Does this model exist? If not, remove it.

---

## Recommended Fixes

### Priority 1: AgentsView.tsx (USER-FACING)

```typescript
// Fix model format (dots → dashes)
const modelOptions = [
  "claude-haiku-4-5",           // fixed
  "claude-sonnet-4-5",          // fixed
  "claude-opus-4-5",            // fixed
  "claude-opus-4-5-thinking",   // fixed
  "gpt-5-2",                    // fixed
  "gpt-5-2-thinking",           // fixed (if this model exists)
  "gpt-5-mini",                 // keep
  // "gpt-5-nano",              // remove if doesn't exist
  "gpt-5-2-codex",              // fixed
  "gemini-2-5-flash",           // fixed
];
```

### Priority 2: AgentService.ts (FALLBACK)

```typescript
// Fix default fallback models
openai: "gpt-5-2",          // or keep "gpt-5-mini"
anthropic: "claude-sonnet-4-5",  // fix from claude-3-5
google: "gemini-2-5-flash", // already correct
```

### Priority 3: Add gpt-5-mini to models.ts

```typescript
// Add to CHAT_MODELS in ui/constants/models.ts
{
  id: "gpt-5-mini",
  name: "GPT-5 Mini",
  provider: "openai",
  description: "Fast, efficient model for simple tasks",
  group: "OpenAI",
  supportsThinking: false,
  maxTokens: 16384,
  requiresApiKey: "OPENAI_API_KEY",
}
```

### Priority 4: Update Test Files

**Strategy:** Use `claude-sonnet-4-5` for Anthropic tests, `gpt-5-2` for OpenAI tests, `gemini-2-5-flash` for Google tests.

**Files to update:**
- `tests/llm-streaming-from-storage.ts`
- `tests/chat-session-manager.test.ts`
- `tests/agent-max-tokens.test.ts`
- `test/integration/gateway-storage.test.ts`
- `test/integration/agent-streaming.test.ts`
- Multiple other test files

---

## Summary

**Critical Issues (Fix Now):**
1. ❌ AgentsView.tsx - Wrong format (dots vs dashes)
2. ❌ AgentService.ts - Old fallback model
3. ⚠️  gpt-5-mini missing from models.ts
4. ⚠️  gpt-5-nano doesn't exist anywhere

**Non-Critical (Fix Later):**
5. 🔵 Test files using old models (GPT-4/Claude 3.5)
6. 🔵 Integration tests using `claude-3-5-sonnet-20241022`

**Impact Assessment:**
- **User-facing:** AgentsView.tsx broken (can't create agents with correct models)
- **API fallback:** Wrong model on failure
- **Tests:** Working but outdated

---

## Action Plan

1. Fix AgentsView.tsx model IDs (dots → dashes)
2. Add gpt-5-mini to models.ts
3. Fix AgentService.ts fallback model
4. Remove gpt-5-nano or add it to models.ts
5. Update test files to use current models
