# Bash Tool Custom Keys Integration Fix

**Date:** 2026-02-19  
**Issue:** Bash tool not loading custom keys from Settings - only checking environment variables

---

## Problem

When user adds a custom API key in Settings (e.g., `PAPRWORK_PUBLICREPOS`), bash commands using `${PAPRWORK_PUBLICREPOS}` would fail:

```javascript
bash({ 
  command: 'curl -H "Authorization: Bearer ${PAPRWORK_PUBLICREPOS}" ...' 
})

// Error: Key not found in environment
// Agent: "The token isn't in the shell environment"
```

**Why:** The bash tool was ONLY checking `process.env` for keys, not CustomKeysStorage where user-configured keys are stored.

---

## Root Cause

### Before (Broken Code):

```typescript
// src/core/tools/bash.ts (lines 82-91)

// Build custom keys map from environment
const customKeys: Record<string, string> = {};
for (const key of apiKeys) {
  const keyName = Object.keys(process.env).find(
    (k) => process.env[k] === key
  );
  if (keyName) {
    customKeys[keyName] = key;
  }
}
// ❌ ONLY checks process.env - misses custom keys from Settings!
```

This meant:
- ✅ Environment keys worked (`OPENAI_API_KEY`, etc.)
- ❌ Custom keys from Settings didn't work (`GITHUB_TOKEN`, `PAPRWORK_PUBLICREPOS`, etc.)

---

## Solution

### After (Fixed Code):

```typescript
// Build custom keys map from environment AND CustomKeysStorage
const customKeys: Record<string, string> = {};

// 1. Add keys from environment
for (const key of apiKeys) {
  const keyName = Object.keys(process.env).find(
    (k) => process.env[k] === key
  );
  if (keyName) {
    customKeys[keyName] = key;
  }
}

// 2. Add keys from CustomKeysStorage (user-configured keys)
try {
  const { getCustomKeysService } = await import("../../gateway/services/CustomKeysService.js");
  const service = getCustomKeysService();
  const storedKeys = await service.listKeys();
  
  // Fetch values for all stored keys
  for (const keyMeta of storedKeys) {
    const value = await service.getKeyByName(keyMeta.name);
    if (value) {
      customKeys[keyMeta.name] = value;
      // Add to apiKeys array for sanitization
      if (!apiKeys.includes(value)) {
        apiKeys.push(value);
      }
    }
  }
} catch (error) {
  console.warn('[Bash Tool] Failed to load custom keys:', error);
  // Continue without custom keys - env vars still work
}
```

---

## What Changed

### Key Loading Flow

**Before:**
```
bash tool starts
    ↓
Check process.env only
    ↓
Build customKeys map
    ↓
Substitute ${KEY_NAME}
    ↓
❌ Custom keys from Settings not found
```

**After:**
```
bash tool starts
    ↓
Check process.env
    ↓
Check CustomKeysStorage (Settings)
    ↓
Merge both into customKeys map
    ↓
Substitute ${KEY_NAME}
    ↓
✅ All keys work (env + custom)
```

### Files Modified

1. **`src/core/tools/bash.ts`** - `executeBashCommand()` function
   - Added CustomKeysStorage integration
   - Lines ~79-115

2. **`src/core/tools/bash.ts`** - `executeBashCommandStreaming()` function
   - Same fix for streaming version
   - Lines ~262-300

---

## Testing

### Test Case 1: Custom Key from Settings

```javascript
// User adds in Settings: GITHUB_TOKEN = ghp_abc123...

bash({ 
  command: 'curl -H "Authorization: Bearer ${GITHUB_TOKEN}" https://api.github.com/repos/...' 
})

// Before: ❌ "GITHUB_TOKEN not found in environment"
// After:  ✅ Substitutes ghp_abc123... and executes successfully
```

### Test Case 2: Environment Key

```javascript
// OPENAI_API_KEY set in .env.local

bash({ 
  command: 'curl -H "Authorization: Bearer ${OPENAI_API_KEY}" ...' 
})

// Before: ✅ Works (from env)
// After:  ✅ Still works (from env)
```

### Test Case 3: Mixed Keys

```javascript
// OPENAI_API_KEY in env, GITHUB_TOKEN in Settings

bash({ 
  command: 'curl "${OPENAI_API_KEY}" && curl "${GITHUB_TOKEN}"' 
})

// Before: ❌ Only OPENAI_API_KEY works
// After:  ✅ Both keys work
```

### Test Case 4: Job Using Custom Key

```javascript
// Job code in ~/papr-jobs/my-job/main.py (or any job script)
// Job calls bash tool via agent

job.bash({ 
  command: 'curl -H "Authorization: Bearer ${GITHUB_TOKEN}" https://api.github.com/repos/...' 
})

// Before: ❌ "GITHUB_TOKEN not found in environment"
// After:  ✅ Works! Job loads key from Settings automatically

// ✅ Jobs inherit the fix - no job-specific changes needed
// ✅ Jobs can use ${GITHUB_TOKEN}, ${OPENAI_API_KEY}, etc.
// ✅ Jobs CANNOT see token values (sanitized to ***)
```

---

## Impact

### Before Fix

| Key Source | Works? | Example |
|------------|--------|---------|
| Environment variables | ✅ | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` |
| Settings → Custom Keys | ❌ | `GITHUB_TOKEN`, `PAPRWORK_PUBLICREPOS` |
| Jobs with custom keys | ❌ | Jobs couldn't access Settings keys |

### After Fix

| Key Source | Works? | Example |
|------------|--------|---------|
| Environment variables | ✅ | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` |
| Settings → Custom Keys | ✅ | `GITHUB_TOKEN`, `PAPRWORK_PUBLICREPOS` |
| Jobs with custom keys | ✅ | Jobs automatically load from Settings |

---

## Why This Matters

### User Experience

**Before:**
```
User: "Fetch my GitHub repos"
Agent: [calls bash with ${GITHUB_TOKEN}]
Agent: "Token not found in environment"
Agent: [tells user to export GITHUB_TOKEN in terminal]
```

**After:**
```
User: "Fetch my GitHub repos"
Agent: [calls bash with ${GITHUB_TOKEN}]
Agent: [loads from Settings, substitutes value]
✅ API call succeeds
```

### Jobs

**Before:**
- Jobs couldn't use custom keys from Settings
- Had to hardcode keys in job scripts (insecure!)
- Or export keys manually before running job

**After:**
- ✅ Jobs automatically get custom keys from Settings
- ✅ Secure: keys encrypted in Keychain
- ✅ No manual export needed
- ✅ Same bash tool as main agent (consistency)

---

## Security

The fix maintains all security features:

1. ✅ **Encryption** - Keys still encrypted in Keychain
2. ✅ **Permission prompts** - First use still prompts
3. ✅ **Output sanitization** - Values replaced with `***`
   - ✅ stdout sanitized
   - ✅ stderr sanitized
   - ✅ command sanitized
   - ✅ errors sanitized
4. ✅ **Audit trail** - Key usage tracked
5. ✅ **Jobs protected** - Jobs can USE tokens but NEVER SEE them

**No security compromises** - just fixed the lookup logic.

**See:** `docs/CUSTOM_KEYS_SECURITY_AND_JOBS.md` for comprehensive security analysis.

---

## Error Handling

If CustomKeysStorage fails to load:
- ✅ Gracefully falls back to environment-only keys
- ✅ Logs warning to console
- ✅ bash tool continues to work (degraded but not broken)

```typescript
try {
  // Load custom keys
} catch (error) {
  console.warn('[Bash Tool] Failed to load custom keys:', error);
  // Continue without custom keys - env vars still work
}
```

---

## Related Issues

This fix solves several related problems:

1. **"Token not in shell environment"** - Agent couldn't find custom keys
2. **401 errors with valid keys** - Keys weren't being substituted
3. **Jobs can't access Settings keys** - Jobs now work with custom keys
4. **Inconsistent behavior** - Environment keys worked, custom keys didn't

---

## Summary

**Problem:** Bash tool only checked `process.env`, not CustomKeysStorage  
**Solution:** Load keys from both environment AND Settings  
**Impact:** Custom keys from Settings now work in bash commands and jobs  
**Security:** No changes - still encrypted, permission-controlled, sanitized  

✅ **Custom keys from Settings now work exactly like environment keys!**
