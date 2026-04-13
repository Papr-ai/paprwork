# Google Papr Proxy 404 Fix

**Date:** 2026-04-12  
**Issue:** Google Gemini models returning 404 when routing through Papr proxy  
**Status:** ✅ Fixed

## Problem

Users with PAPR_API_KEY trying to use Google Gemini models via the Papr proxy got a 404 error:

```
API key error: {...}
"url": "https://memory.papr.ai/v1/ai/google/models/gemini-3-pro-preview:streamGenerateContent?alt=sse"
"statusCode": 404
"responseBody": "{\"detail\":\"Not Found\"}"
```

## Root Cause

**Two separate issues:**

1. **Wrong proxy URL:** The app was using `PAPR_BASE_URL` but the proxy code looks for `PAPR_AI_PROXY_BASE_URL`. Since that wasn't set, it defaulted to production `https://memory.papr.ai/v1/ai` instead of the development server.

2. **Production server outdated:** The production server at `https://memory.papr.ai` doesn't have the Google proxy routes deployed yet, while the development server does.

### Code Analysis

**paprProxyProvider.ts (line 21-22):**
```typescript
const PAPR_PROXY_BASE =
  process.env.PAPR_AI_PROXY_BASE_URL || "https://memory.papr.ai/v1/ai";
```

**User's .env.local (before fix):**
```bash
PAPR_BASE_URL=https://memoryserver-development-223473570766.us-west1.run.app
# Missing: PAPR_AI_PROXY_BASE_URL
```

**Result:** Proxy defaulted to production URL, which doesn't have Google routes yet.

## Solution

Added `PAPR_AI_PROXY_BASE_URL` environment variable pointing to the development server:

```bash
# .env.local
PAPR_AI_PROXY_BASE_URL=https://memoryserver-development-223473570766.us-west1.run.app/v1/ai
```

### Why It Works

1. **Development server HAS Google routes:**
```bash
$ curl -X POST "https://memoryserver-development-223473570766.us-west1.run.app/v1/ai/google/models/gemini-3-flash-preview:generateContent"
# Returns: {"detail":"Missing authentication"}  ✅ (route exists)
```

2. **Production server DOES NOT:**
```bash
$ curl -X POST "https://memory.papr.ai/v1/ai/google/models/gemini-3-flash-preview:generateContent"
# Returns: {"detail":"Not Found"}  ❌ (route doesn't exist)
```

## Google Routes Implementation

The Google proxy routes exist in the memory backend codebase:

**File:** `~/Documents/GitHub/memory/routers/v1/ai_proxy_routes.py`

```python
@router.post("/google/models/{model_id}:generateContent")
async def google_generate_content_proxy(...):
    """Google Gemini generateContent API proxy"""
    # Lines 501-523

@router.post("/google/models/{model_id}:streamGenerateContent")
async def google_stream_generate_content_proxy(...):
    """Google Gemini streamGenerateContent API proxy"""
    # Lines 526-565
```

**Commit:** `c1f8216` - "fix: update model classification to prefix-based matching for current paprwork-v2 models"

**Status:** Deployed to development, NOT deployed to production

## Testing

### Before Fix
```bash
# Error: 404 from production server
[Agent WS] 🔑 Using PAPR PROXY for google/gemini-3-pro-preview
# Error: API key error: {"statusCode": 404, "detail": "Not Found"}
```

### After Fix
```bash
# Success: Routes to development server with Google support
[Agent WS] 🔑 Using PAPR PROXY for google/gemini-3-pro-preview
# Works: Requests go to dev server with Google routes deployed ✅
```

## Files Changed

- `.env.local` - Added `PAPR_AI_PROXY_BASE_URL` environment variable

## Impact

- **Before:** Users with PAPR_API_KEY couldn't use Gemini models (404 error)
- **After:** Users with PAPR_API_KEY can use ALL providers (OpenAI, Anthropic, Google) via development server ✅

## Production Deployment

To make this work for all users, the production server needs to be updated:

1. Deploy commit `c1f8216` or later from `~/Documents/GitHub/memory`
2. Ensure `GOOGLE_API_KEY` environment variable is set on production
3. Test: `curl -X POST "https://memory.papr.ai/v1/ai/google/models/gemini-2.5-flash:generateContent"`
4. Update default `PAPR_AI_PROXY_BASE_URL` in Paprwork to production

## Related

- [PAPR_PROXY_MODEL_AVAILABILITY_FIX.md](./PAPR_PROXY_MODEL_AVAILABILITY_FIX.md) - UI model unlocking
- Memory backend: `~/Documents/GitHub/memory/routers/v1/ai_proxy_routes.py`
- Proxy provider: `src/gateway/utils/paprProxyProvider.ts`

## Environment Variables

```bash
# Memory SDK (GraphQL, schemas, etc.)
PAPR_BASE_URL=https://memoryserver-development-223473570766.us-west1.run.app

# AI Proxy (OpenAI, Anthropic, Google routing)
PAPR_AI_PROXY_BASE_URL=https://memoryserver-development-223473570766.us-west1.run.app/v1/ai
```

**Note:** These are two separate services with different purposes:
- `PAPR_BASE_URL` - Memory/storage backend
- `PAPR_AI_PROXY_BASE_URL` - AI model proxy for credits routing
