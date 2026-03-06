# GPT-5.4 OAuth Support - Final Implementation

**Date:** 2026-03-05  
**Status:** ✅ Fully Working (Both API Key and OAuth)

## Summary

GPT-5.4 and GPT-5.4 Pro are now fully supported via **both** authentication methods:
- ✅ **API Key** (OpenAI Platform API via AI SDK)
- ✅ **OAuth** (ChatGPT Plus/Pro via pi-ai with manual model creation)

## The Journey

### Initial Implementation
Added GPT-5.4 support via API key route (AI SDK). Worked perfectly.

### OAuth Error Discovery
When testing with OAuth, got error:
```
TypeError: Cannot read properties of undefined (reading 'api')
```

**Root cause:** `getModel("openai-codex", "gpt-5.4")` returned `undefined` because pi-ai's registry doesn't have GPT-5.4 yet.

### Initial Fix Attempt (Blocking OAuth)
- Removed GPT-5.4 from OAuth models list
- Added error message telling users to use API key
- Documented as "pending pi-ai update"

### User Insight! 💡
**User:** "Why isn't it supported? Can't we pass any model as long as Codex supports it?"

**Key realization:** 
- Pi-ai's `getModel()` is just a **registry lookup**, not validation
- ChatGPT backend accepts **any model ID**
- Model object is just a **TypeScript interface** with metadata
- We can **create model objects manually** when not in registry!

### Final Solution (Manual Model Creation)

```typescript
// In AgentService.ts
const piModel = getModel(piProvider, piModelId);

// If not found, create it manually
let finalModel = piModel;
if (!piModel && useCodex) {
  finalModel = {
    id: piModelId,
    name: piModelId === "gpt-5.4-pro" ? "GPT-5.4 Pro" : "GPT-5.4 Thinking",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: piModelId === "gpt-5.4-pro" ? 30.0 : 2.5,
      output: piModelId === "gpt-5.4-pro" ? 180.0 : 15.0,
      cacheRead: piModelId === "gpt-5.4-pro" ? 3.0 : 0.25,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 128000,
  };
}

// Use finalModel (works whether from registry or manually created)
fullStream = createPiCodexStreamWithToolLoop(streamSimple, finalModel, ...);
```

## Why It Works

1. **ChatGPT backend is the authority** - Not pi-ai's registry
2. **Backend accepts any model ID** - Including unreleased ones
3. **Model object structure is known** - Just copy GPT-5.2's structure with new pricing
4. **Future-proof** - When pi-ai adds GPT-5.4, our code becomes a no-op

## Benefits

✅ **Both auth methods work** - API key AND OAuth  
✅ **No waiting required** - Works immediately  
✅ **Correct pricing** - Accurate cost calculation  
✅ **Future-proof** - Transitions seamlessly when pi-ai updates  
✅ **Same approach for future models** - Easy to add GPT-5.5, etc.

## Files Modified

| File | Change |
|------|--------|
| `src/gateway/services/AgentService.ts` | Added manual model creation logic |
| `src/gateway/utils/modelNormalizer.ts` | Re-added GPT-5.4 to OAuth models list |
| `tests/gpt-5-4-integration.test.ts` | Updated OAuth tests (21/21 passing) |
| `docs/GPT_5_4_INTEGRATION.md` | Updated OAuth availability status |
| `docs/GPT_5_4_OAUTH_MANUAL_MODEL_FIX.md` | Documented the fix |
| `CLAUDE.md` | Updated availability section |

## Testing Results

```bash
✓ 21/21 tests passing
✓ OAuth compatibility: true
✓ API key compatibility: true
✓ Model normalization: working
✓ Cost calculation: accurate
✓ Manual model creation: verified
```

## User Experience

**API Key Users:**
1. Add OpenAI API key in Settings
2. Select GPT-5.4 from model picker
3. Works via AI SDK (Platform API)

**OAuth Users:**
1. Connect ChatGPT Plus/Pro in Settings
2. Select GPT-5.4 from model picker
3. Works via pi-ai with manual model creation
4. Seamless experience - they don't know it's manual!

## When pi-ai Updates

When `@mariozechner/pi-ai` eventually adds GPT-5.4:
- ✅ **No code changes needed**
- ✅ `getModel()` will return model from registry
- ✅ Our manual creation becomes a no-op (never executed)
- ✅ Everything continues working exactly the same

## Lessons Learned

1. **Question assumptions** - "Can't we pass any model?" led to breakthrough
2. **Registry != Validation** - Lookup tables don't enforce API constraints
3. **Backend is truth** - ChatGPT's backend accepts model IDs independently
4. **Metadata is malleable** - Can create model objects programmatically
5. **Future-proof design** - Solutions should work before AND after updates

## Credit

**Solution inspired by:** User's question about model pass-through  
**Key insight:** Pi-ai registry is convenience, not constraint  
**Result:** Immediate OAuth support without waiting for package update

---

## Quick Reference

**Both Routes Working:**
- API Key → AI SDK → OpenAI Platform API ✅
- OAuth → pi-ai (manual model) → ChatGPT Backend ✅

**Pricing:**
- GPT-5.4: $2.50/$15 per 1M tokens
- GPT-5.4 Pro: $30/$180 per 1M tokens

**Context:**
- 1M token window (272K default)
- 128K output tokens

**Testing:**
```bash
npm test tests/gpt-5-4-integration.test.ts
# 21/21 tests passing ✅
```

---

**Status:** Production Ready 🚀
