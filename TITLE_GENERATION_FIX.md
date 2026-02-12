# Title Generation Fix

## Problem

Titles were showing truncated user messages instead of AI-generated titles because:
1. OpenAI API key exists in `.env.local` but not in Electron's secure storage
2. The fallback was too simplistic (just truncating at 40 chars)

## Solution

### 1. Better Fallback (Immediate Fix) ✅

Added smart fallback title generation that:
- Removes common prefixes ("can you", "how do i", etc.)
- Capitalizes first letter
- Breaks at word boundaries when truncating
- Returns clean, readable titles even without AI

**Example transformations:**
- `"how do i connect to postgres?"` → `"Connect to postgres?"`
- `"can you help me understand recursion"` → `"Help me understand recursion"`
- `"what is the capital of france?"` → `"Capital of france?"`

### 2. Add OpenAI Key to Secure Storage (For AI Titles)

Run this script once to enable AI-powered title generation:

```bash
npx tsx scripts/add-openai-key.ts
```

This reads the key from `.env.local` and adds it to Electron's secure storage (keychain on macOS).

## Testing

**Before fix:**
- Title: `"how do i connect to postgres? I'v..."`

**After fix (fallback):**
- Title: `"Connect to postgres?"`

**After adding key (AI):**
- Title: `"PostgreSQL Connection Guide"` (AI-generated)

## Files Changed

1. `src/gateway/services/AgentService.ts` - Better fallback logic
2. `scripts/add-openai-key.ts` - Helper to add key to secure storage

## Why Keys Aren't Automatically Migrated

Electron's secure storage (safeStorage) requires the app to be running. Keys in `.env.local` are for development/testing. In production:
- Users add keys via Settings UI
- Keys are stored securely in keychain/credential manager
- Gateway requests keys via IPC when needed

For now, the smart fallback provides good titles without AI.
