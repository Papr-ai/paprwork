# Papr Proxy Model Availability Fix

**Date:** 2026-04-12  
**Issue:** Models showing as locked even when user has PAPR_API_KEY  
**Status:** ✅ Fixed

## Problem

When a user is logged in to Papr (has `PAPR_API_KEY`), all AI models (GPT, Claude, Gemini) should be available because they can proxy through Papr's API. However, the UI was incorrectly showing these models as "locked" with a lock icon, making users think they couldn't use them.

**User Experience:**
- User logs in to Papr ✅
- Opens model picker in chat
- Sees all models with 🔒 lock icons ❌
- Thinks they can't use AI models
- Actually CAN use them (backend would proxy) but UI doesn't show it

## Root Cause

The `useAuthStatus` hook in `ui/hooks/useAuthStatus.ts` was only checking for:
1. Direct provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`)
2. OAuth tokens (ChatGPT Plus, Claude Pro)

It was NOT checking for `PAPR_API_KEY`, which enables ALL providers via proxy.

### Code Before
```typescript
const isModelAvailable = useCallback(
  (model: { provider: string; requiresApiKey: string }) => {
    if (model.provider === "ollama") {
      return true;
    }
    if (model.provider === "openai") {
      return status.openai.oauth || status.openai.apiKey;
    }
    if (model.provider === "anthropic") {
      return status.anthropic.oauth || status.anthropic.apiKey;
    }
    if (model.provider === "google") {
      return status.google.apiKey;
    }
    return false; // ❌ Locked if no provider-specific auth
  },
  [status],
);
```

## Solution

Enhanced `useAuthStatus` to track `PAPR_API_KEY` and treat it as a universal authentication method that enables ALL cloud providers.

### Changes Made

1. **Added `paprProxy` to `AuthStatus` interface:**
```typescript
export interface AuthStatus {
  openai: { oauth: boolean; apiKey: boolean };
  anthropic: { oauth: boolean; apiKey: boolean };
  google: { apiKey: boolean };
  paprProxy: boolean; // PAPR_API_KEY enables all providers via proxy
}
```

2. **Track PAPR_API_KEY in state:**
```typescript
const refresh = useCallback(() => {
  const hasKey = (name: string) => keys.some((k) => k.name === name);

  setStatus({
    openai: { ... },
    anthropic: { ... },
    google: { ... },
    paprProxy: hasKey("PAPR_API_KEY"), // ✅ Check for Papr key
  });
}, [keys, ...]);
```

3. **Check `paprProxy` FIRST in `isModelAvailable`:**
```typescript
const isModelAvailable = useCallback(
  (model: { provider: string; requiresApiKey: string }) => {
    // Ollama runs locally, always available (no API key required)
    if (model.provider === "ollama") {
      return true;
    }
    
    // ✅ Papr proxy enables ALL cloud providers (OpenAI, Anthropic, Google)
    if (status.paprProxy) {
      return true;
    }
    
    // Otherwise check provider-specific auth
    if (model.provider === "openai") {
      return status.openai.oauth || status.openai.apiKey;
    }
    // ... etc
  },
  [status],
);
```

## Priority Order

Models are now available in this priority:

1. **Ollama** - Always available (local, no API key needed)
2. **Papr Proxy** - Available if `PAPR_API_KEY` exists (enables ALL providers)
3. **Direct Auth** - Available if provider-specific OAuth or API key exists

## Impact

### Before Fix
- User with only `PAPR_API_KEY`: All models show 🔒 (locked)
- User confused why models unavailable
- Backend would actually work (proxy fallback) but UI misleading

### After Fix
- User with only `PAPR_API_KEY`: All models unlocked ✅
- User sees GPT, Claude, Gemini all available
- Backend proxies through Papr (as it already did)
- UI matches actual functionality

## Testing

### Test Case 1: Papr Login Only
1. ✅ Login to Papr (PAPR_API_KEY stored)
2. ✅ Remove all direct API keys
3. ✅ Open model picker in chat
4. ✅ Verify ALL models are unlocked (no 🔒 icon)
5. ✅ Select GPT-5.2, send message
6. ✅ Console shows: `🔑 Using PAPR PROXY for openai/gpt-5.2`

### Test Case 2: Direct API Key + Papr
1. ✅ Have both OPENAI_API_KEY and PAPR_API_KEY
2. ✅ Send message with GPT model
3. ✅ Console shows: `🔑 Using DIRECT API KEY for openai/gpt-5.2`
4. ✅ Direct key takes priority (faster, no proxy overhead)

### Test Case 3: OAuth + Papr
1. ✅ Connect ChatGPT Plus OAuth
2. ✅ Also have PAPR_API_KEY
3. ✅ Send message with GPT model
4. ✅ Console shows: `🔑 Using OAUTH for openai/gpt-5.2`
5. ✅ OAuth takes priority (uses subscription)

### Test Case 4: No Auth
1. ❌ No PAPR_API_KEY, no OAuth, no API keys
2. ✅ All models show 🔒 (locked) - correct behavior
3. ✅ Cannot send messages until auth configured

## Console Logs for Verification

When you send a message, look for these logs:

### Papr Proxy
```
[Agent WS] No direct openai auth — falling back to Papr AI proxy
[Agent WS] 🔑 Using PAPR PROXY for openai/gpt-5.2 (no direct API key found)
[AgentService] Using Papr AI proxy for openai/gpt-5.2
```

### Direct API Key
```
[Agent WS] Auth resolved for openai: type=apiKey tokenLength=51 tokenPrefix=sk-proj-...
[Agent WS] 🔑 Using DIRECT API KEY for openai/gpt-5.2
```

### OAuth
```
[Agent WS] Auth resolved for openai: type=oauth tokenLength=512 tokenPrefix=eyJhbGciOiJSU...
[Agent WS] 🔑 Using OAUTH for openai/gpt-5.2
```

## Files Changed

- **`ui/hooks/useAuthStatus.ts`** - Added `paprProxy` tracking and priority check
- **`src/gateway/websocket/agent.ts`** - Enhanced logging (previous fix)

## Related

- [PAPR_LOGIN_INTEGRATION.md](./PAPR_LOGIN_INTEGRATION.md) - Papr authentication setup
- [OAUTH_CONTEXT_MANAGEMENT.md](./OAUTH_CONTEXT_MANAGEMENT.md) - OAuth routing
- [Enhancement 27: Smart Default Provider](../CLAUDE.md#enhancement-27) - Backend proxy fallback

## User Messaging

The UI now correctly shows:
- **Settings → AI Models:** "via Papr" badge when no direct keys but PAPR_API_KEY exists
- **Model Picker:** All models unlocked when PAPR_API_KEY present
- **Priority Note:** "Priority: Own API key → OAuth → Papr AI"

This makes it crystal clear that Papr login enables ALL AI models!
