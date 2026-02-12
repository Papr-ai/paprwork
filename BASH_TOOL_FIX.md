# Bash Tool Fix: Optional Parameters

**Date:** 2026-02-12  
**Issue:** Model kept failing with "env field Required" error

## Problem Summary

The bash tool had **two separate concepts** that were causing confusion:

### 1. API Key Substitution ✅ (Already Working)
```bash
# Command from LLM:
curl -H "Authorization: Bearer ${OPENAI_API_KEY}" https://api.openai.com/...

# Paprwork replaces ${OPENAI_API_KEY} with actual value from Settings
# This happens via substituteCustomKeys() - separate from env parameter
```

### 2. Environment Variables ❌ (Causing the error)
```typescript
// env parameter is for bash process environment variables
env: {
  PATH: "/custom/bin",
  NODE_ENV: "production"
}

// Gets passed to child_process.exec()
```

**The Issue:** The schema required `env` even though:
- It's rarely needed (99% of commands don't need custom env vars)
- The code already handled it being empty/optional
- The model naturally doesn't provide it

---

## The Fix

### Changed Schema from Required to Optional

**Before:**
```typescript
const BashInputSchema = z.object({
  command: z.string(),
  cwd: z.string(),           // Required
  timeout: z.number(),        // Required  
  env: z.record(z.string()),  // Required ❌
});
```

**After:**
```typescript
const BashInputSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  cwd: z.string().optional(),
  timeout: z.number().optional(),
  env: z.record(z.string()).optional(),  // ✅ Optional
});
```

### Added Smart Defaults

```typescript:src/core/tools/bash.ts
// Apply defaults for optional parameters
let { command } = input;
const cwd = input.cwd || "";
const timeout = input.timeout || 60000;
const env = input.env || {};
```

### Updated System Prompt

**Before:**
```
IMPORTANT: All 4 parameters are REQUIRED. Do not omit any field.
```

**After:**
```
bash({
  command: "ls -la"     // Only command is required
})

**Optional Parameters** (have smart defaults):
- cwd: Working directory (default: current directory)
- timeout: Timeout in ms (default: 60000)
- env: Environment variables (default: system environment)
```

---

## Why This is Better

### UX Benefits
- ✅ Model can use natural, simple tool calls: `bash({ command: "ls" })`
- ✅ No more validation errors for omitted optional fields
- ✅ Cleaner, more intuitive API

### Technical Benefits
- ✅ Matches actual implementation (code already handled optional env)
- ✅ Follows principle of least surprise
- ✅ Consistent with other tools (optional = smart defaults)

---

## Test Results

**Before:** Model failed with:
```
Invalid input for tool bash: Type validation failed
Error message: [{ "code": "invalid_type", "expected": "object", "received": "undefined", "path": ["env"], "message": "Required" }]
```

**After:** Model successfully calls bash with minimal input:
```typescript
bash({ command: "ls -la ~/Dropbox" })
// Internally becomes: { command: "ls -la ~/Dropbox", cwd: "", timeout: 60000, env: {} }
```

---

## Files Modified

1. `src/core/tools/bash.ts` - Made env/cwd/timeout optional with defaults
2. `src/core/agents/SystemPrompt.ts` - Updated documentation to reflect optional params
3. Both `executeBashCommand` and `executeBashCommandStreaming` updated

---

## Key Takeaway

**The `env` parameter is NOT for API key substitution!**

- **API keys:** Use `${KEY_NAME}` in command → replaced by `substituteCustomKeys()`
- **Environment vars:** Use `env: { VAR: "value" }` → passed to bash process

Most commands don't need custom environment variables, so making `env` optional aligns with real-world usage.

---

**Status:** ✅ Complete - Model can now call bash tool without validation errors
