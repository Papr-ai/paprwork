# TypeScript Errors Fix

**Date:** 2026-02-17  
**Issue:** Multiple TypeScript compilation errors and linting issues  
**Status:** ✅ Fixed

---

## Issues Fixed

### 1. ModelFallback.ts - Outdated Model IDs

**Problem:** `ModelFallback.ts` had outdated/incorrect model IDs that didn't match the actual models used in the app.

**Old Models:**
- ❌ `claude-sonnet-4-20250514` (API version format)
- ❌ `claude-3-5-sonnet-20241022` (old model)
- ❌ `gpt-4o` (GPT-4 era)
- ❌ `gemini-2.0-flash-exp` (experimental suffix)

**Fixed Models:**
- ✅ `claude-haiku-4-5`
- ✅ `claude-sonnet-4-5`
- ✅ `claude-opus-4-5`
- ✅ `claude-opus-4-5-thinking`
- ✅ `gpt-5-2`
- ✅ `gpt-5-2-thinking`
- ✅ `gpt-5-mini`
- ✅ `gemini-2-0-flash`
- ✅ `gemini-1-5-pro`

**Note:** This file is **NOT currently used** in the codebase. It's exported from `src/core/agents/index.ts` but never imported anywhere. Consider this a **future feature** for automatic model fallback on failures.

**Files Changed:**
- `src/core/agents/ModelFallback.ts` - Updated all model IDs to match current models

---

### 2. Test File - AgentConfig vs AgentConfigInternal

**Problem:** Test file `tests/llm-streaming-from-storage.ts` used the wrong type and incorrect chunk type.

**Errors:**
```
❌ Object literal may only specify known properties, and 'apiKey' does not exist in type 'AgentConfig'.
❌ Argument of type 'AgentConfig' is not assignable to parameter of type 'AgentConfigInternal'.
❌ Type '"thinking-delta"' is not comparable to type 'StreamChunkType'.
```

**Root Cause:**
- `AgentConfig` is the **public interface** (no API key) - used by UI
- `AgentConfigInternal` is the **internal interface** (with API key) - used by Gateway/tests
- API keys are fetched via IPC, never sent over WebSocket
- Chunk type was `"thinking-delta"` but should be `"reasoning-delta"`

**Fix:**
```typescript
// ❌ BEFORE
import type { AgentConfig } from "../src/core/types/agents.js";
const config: AgentConfig = {
  apiKey,  // ❌ doesn't exist on AgentConfig
  // ...
};
case "thinking-delta":  // ❌ wrong chunk type

// ✅ AFTER
import type { AgentConfigInternal } from "../src/core/types/agents.js";
const config: AgentConfigInternal = {
  apiKey,  // ✅ exists on AgentConfigInternal
  // ...
};
case "reasoning-delta":  // ✅ correct chunk type
```

**Files Changed:**
- `tests/llm-streaming-from-storage.ts` - Fixed import, type, and chunk type

---

### 3. AgentsView.tsx - Missing React Import

**Problem:** AgentsView.tsx referenced React in JSX but didn't import it.

**Error:**
```
❌ 'React' refers to a UMD global, but the current file is a module. Consider adding an import instead.
```

**Root Cause:**
- TSX files need `import React` for JSX to compile
- Some build configs auto-inject React, but production builds don't

**Fix:**
```typescript
// ❌ BEFORE
import { useEffect, useMemo, useState } from "react";

// ✅ AFTER
import React, { useEffect, useMemo, useState } from "react";
```

**Files Changed:**
- `ui/components/Agents/AgentsView.tsx` - Added React import

---

## Architecture Notes

### AgentConfig vs AgentConfigInternal

**Why two types?**

For **security** - API keys never leave the Gateway:

```
UI (Renderer)
  ↓ WebSocket (no API key)
  ↓ { provider, model, systemPrompt, ... }
  ↓
Gateway
  ↓ IPC request to Main Process
  ↓ "give me API key for anthropic"
  ↓
Main Process
  ↓ reads from CustomKeysStorage (encrypted)
  ↓ returns API key
  ↓
Gateway
  ↓ adds API key to config
  ↓ AgentConfig → AgentConfigInternal
  ↓ calls Mastra with full config
```

**Files:**
- `src/core/types/agents.ts`:
  - `AgentConfig` - Public interface (UI → Gateway)
  - `AgentConfigInternal` - Internal interface (Gateway → Mastra)

### Stream Chunk Types

**Valid types** (from `src/core/types/streaming.ts`):
```typescript
type StreamChunkType =
  | "text-delta"
  | "reasoning-delta"  // ✅ Not "thinking-delta"
  | "tool-call"
  | "tool-call-delta"
  | "tool-result"
```

**Why "reasoning-delta"?**
- Mastra SDK uses "reasoning" terminology
- Matches Anthropic's "thinking" and OpenAI's "reasoning"
- UI still calls it "thinking" for user-facing display

---

## Verification

```bash
npm run type-check
# ✅ Gateway: no errors
# ✅ Electron: no errors
# ✅ UI: no errors
```

---

## ModelFallback.ts - Future Feature

**Status:** Implemented but not used

**Purpose:** Automatic model fallback on failures
- If primary model fails (rate limit, timeout, etc.)
- Automatically retry with fallback model
- Continue until success or max retries

**Example:**
```
Request: claude-opus-4-5
  ↓ (overloaded error)
Fallback: claude-sonnet-4-5
  ↓ (rate limit error)
Fallback: claude-haiku-4-5
  ↓ ✅ Success!
```

**When to implement:**
1. User reports frequent rate limits
2. Need production resilience
3. Multi-model cost optimization

**Files:**
- `src/core/agents/ModelFallback.ts` - Ready to use
- Exported from `src/core/agents/index.ts`
- Not yet integrated into `MastraAgent.ts`

---

## Summary

✅ **All TypeScript errors fixed**
✅ **Model IDs updated to current models**
✅ **Security architecture preserved** (no API keys over WebSocket)
✅ **ModelFallback ready for future use**

**Build Status:**
```
✓ tsc --noEmit (Gateway)
✓ tsc --noEmit (Electron)
✓ tsc --noEmit (UI)
```
