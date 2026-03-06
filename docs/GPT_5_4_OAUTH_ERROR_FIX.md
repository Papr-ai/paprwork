# GPT-5.4 OAuth Error Fix

**Date:** 2026-03-05  
**Issue:** `Cannot read properties of undefined (reading 'api')` when using GPT-5.4 with OAuth

## Problem

When attempting to use GPT-5.4 models with ChatGPT OAuth authentication, the system threw an error:

```
TypeError: Cannot read properties of undefined (reading 'api')
    at streamSimple (node_modules/@mariozechner/pi-ai/dist/stream.js:21:47)
```

## Root Cause

The `@mariozechner/pi-ai` package (which handles ChatGPT OAuth authentication) doesn't have GPT-5.4 model definitions yet. When the code called `getModel("openai-codex", "gpt-5.4")`, it returned `undefined` because the model doesn't exist in pi-ai's registry.

**Models currently in pi-ai:**
- ✅ gpt-5.2, gpt-5.2-codex, gpt-5.2-pro
- ✅ gpt-5.3-codex, gpt-5.3-codex-spark
- ❌ gpt-5.4 (not yet added)
- ❌ gpt-5.4-pro (not yet added)

## Solution

Removed GPT-5.4 models from the OAuth-compatible models list until pi-ai is updated:

### File: `src/gateway/utils/modelNormalizer.ts`

```typescript
/** Models that pi-ai openai-codex (ChatGPT OAuth) supports */
const OPENAI_CODEX_MODELS = new Set([
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.2-low",
  "gpt-5.2-high",
  "gpt-5.1",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  // Note: GPT-5.4 models not yet available in pi-ai (as of 2026-03-05)
  // Will be added when pi-ai package is updated
]);
```

## Current Status

**✅ API Key Authentication** - Fully working
- Users can use GPT-5.4 models with OpenAI API keys
- Works via AI SDK (Platform API)
- All features functional (streaming, tools, context management)

**⏳ OAuth Authentication** - Pending pi-ai update
- GPT-5.4 models not yet available via ChatGPT OAuth
- Users with ChatGPT Plus/Pro should use API key temporarily
- Will be enabled automatically when pi-ai adds GPT-5.4 support

## Files Updated

1. `src/gateway/utils/modelNormalizer.ts` - Removed GPT-5.4 from OAuth models
2. `tests/gpt-5-4-integration.test.ts` - Updated tests to expect API-key-only
3. `docs/GPT_5_4_INTEGRATION.md` - Documented OAuth limitation
4. `docs/GPT_5_4_IMPLEMENTATION_SUMMARY.md` - Updated status
5. `CLAUDE.md` - Clarified availability

## User Impact

**Before Fix:**
- ❌ OAuth users got error: "Cannot read properties of undefined"
- ❌ System tried to use pi-ai for GPT-5.4 and crashed

**After Fix:**
- ✅ System recognizes GPT-5.4 requires API key
- ✅ Clear error if OAuth user tries to use GPT-5.4 without API key
- ✅ API key users can use GPT-5.4 without issues

## Future Action

When `@mariozechner/pi-ai` is updated with GPT-5.4 support:

1. Uncomment GPT-5.4 entries in `OPENAI_CODEX_MODELS` set
2. Update tests to expect OAuth compatibility
3. Update documentation to remove "pending" status
4. No other code changes needed - OAuth routing will work automatically

## Monitoring

Check pi-ai package for updates:
```bash
npm outdated @mariozechner/pi-ai
```

Or watch GitHub releases:
https://github.com/mariozechner/pi-ai

## Testing

All tests passing after fix:
```bash
✓ 20/20 tests in gpt-5-4-integration.test.ts
✓ Correctly identifies GPT-5.4 as NOT OAuth-compatible (yet)
✓ Cost calculation working
✓ Model normalization working
```

## Workaround for Users

If users want to use GPT-5.4 right now:

1. **Get OpenAI API Key**
   - Go to https://platform.openai.com/api-keys
   - Create new API key
   - Add credits to account

2. **Add to Paprwork**
   - Open Settings
   - Add OpenAI API key
   - Select GPT-5.4 from model picker
   - Works immediately!

---

**Summary:** GPT-5.4 OAuth error fixed by correctly limiting to API key authentication until pi-ai package adds GPT-5.4 support. No functionality lost - API key route fully operational.
