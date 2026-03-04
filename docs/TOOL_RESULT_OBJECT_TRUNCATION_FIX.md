# Tool Result Object Truncation Fix

**Date:** 2026-03-03  
**Issue:** Context length exceeded error despite existing truncation logic  
**Symptom:** `prompt is too long: 210833 tokens > 200000 maximum`

---

## Problem

The agent hit a context length exceeded error even though Issue 8 (Tool Result Truncation) was supposedly fixed. Looking at the logs:

```
[AgentService] Tool bash raw result: 350143 chars
[AgentService] 📈 Step 6 - input: 56066 tokens, output: 170 tokens (current context: 56066)
APICallError: prompt is too long: 210833 tokens > 200000 maximum
```

**What happened:**
1. Step 6 showed 56K tokens (fine)
2. A bash tool returned **350KB of output** (~350,143 chars)
3. When this was added to the next step's context, it jumped to **210K tokens**
4. This exceeded Claude's 200K token limit

---

## Root Cause

The `prepareStep` logic in `AgentService.ts` had a critical flaw:

```typescript
// OLD CODE (line 622) - ONLY truncated strings
if (part.type === "tool-result" && typeof part.result === "string") {
  const resultStr = part.result;
  // ... truncation logic
}
```

**The problem:**
- Only truncated results that were **strings**
- Most tools (bash, read_app_file, etc.) return **objects**: `{ success: true, data: { stdout, stderr, ... } }`
- These large objects **bypassed all truncation logic** completely
- Even the EMERGENCY_LIMIT (200KB) wasn't applied to objects

---

## The Fix

Modified `prepareStep` to handle both strings AND objects:

```typescript
// NEW CODE - Truncates both strings and objects
const truncateToolResult = (
  result: unknown,
  maxLength: number | null,
  toolMessagePosition: number,
): unknown => {
  // Handle undefined/null results (can happen with certain tool errors)
  if (result === undefined || result === null) {
    return result;
  }

  // Convert result to string for size check (handles both strings and objects)
  const resultStr =
    typeof result === "string" ? result : JSON.stringify(result);

  // EMERGENCY: Catch absurdly large results (>50K tokens) regardless of recency
  const EMERGENCY_LIMIT = 200000; // ~50K tokens
  if (resultStr.length > EMERGENCY_LIMIT) {
    const truncated = resultStr.substring(0, EMERGENCY_LIMIT);
    const omitted = resultStr.length - EMERGENCY_LIMIT;
    console.warn(
      `[prepareStep] ⚠️ EMERGENCY truncation: tool result was ${Math.round(resultStr.length / 1024)}KB, ` +
        `truncated to ${Math.round(EMERGENCY_LIMIT / 1024)}KB`,
    );
    return (
      truncated +
      `\n\n[⚠️ EMERGENCY TRUNCATION: Result was ${Math.round(resultStr.length / 1024)}KB ...]`
    );
  }

  // Keep unlimited for most recent (unless emergency truncation applied above)
  if (maxLength === null) {
    return result;
  }

  if (resultStr.length > maxLength) {
    const truncated = resultStr.substring(0, maxLength);
    const omitted = resultStr.length - maxLength;
    const positionFromEnd = totalToolMessages - toolMessagePosition - 1;
    const estimatedTokens = Math.ceil(maxLength / 4);
    return (
      truncated +
      `\n\n[... ${omitted} chars truncated (tool #${positionFromEnd + 1} from end, ` +
      `limit: ~${estimatedTokens} tokens, context: ${Math.round(totalPromptTokens / 1000)}K/${pressureLevel})]`
    );
  }

  return result;
};

// Now check for tool-result regardless of type
if (part.type === "tool-result") {
  const truncatedResult = truncateToolResult(
    part.result,
    maxLength,
    toolMessagePosition,
  );

  return {
    ...part,
    result: truncatedResult,
  };
}
```

---

## Key Changes

1. **Null/undefined check:** Added early return for `undefined` or `null` results to prevent crashes
2. **Helper function:** Created `truncateToolResult()` that handles both strings and objects
3. **Type-agnostic:** Uses `typeof result === "string" ? result : JSON.stringify(result)` to measure size
4. **Removed type check:** Changed from `part.type === "tool-result" && typeof part.result === "string"` to just `part.type === "tool-result"`
5. **Same limits:** EMERGENCY_LIMIT still 200KB, recency-based limits unchanged

### Edge Case: Undefined Results

During testing, we discovered that `part.result` can sometimes be `undefined` (e.g., when a tool errors before producing output). The initial fix crashed with:

```
TypeError: Cannot read properties of undefined (reading 'length')
```

**Solution:** Added null/undefined check at the start of `truncateToolResult()`:
```typescript
if (result === undefined || result === null) {
  return result;
}
```

This prevents crashes when processing tool results that are empty or errored.

---

## Impact

**Before:**
- Tool results that were objects bypassed truncation entirely
- A single 350KB bash output blew up the context window
- Only string results got truncated

**After:**
- ALL tool results get truncated (strings AND objects)
- Emergency limit (200KB) now applies universally
- Recency-based truncation works for all tool types

---

## Affected Tools

The following tools return **objects** (were previously not truncated):
- ✅ `bash` - Returns `{ success: true, data: { stdout, stderr, exitCode, ... } }`
- ✅ `read_app_file` - Returns `{ success: true, data: { content, ... } }`
- ✅ `create_job` - Returns `{ success: true, data: { jobId, ... } }`
- ✅ `run_job` - Returns `{ success: true, data: { result, logs, ... } }`

Most tools in the codebase return structured objects following the `ToolResult` pattern:

```typescript
interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  type?: string;
  duration?: number;
  timestamp?: string;
}
```

---

## Testing

1. ✅ TypeScript type check passes (no errors in `AgentService.ts`)
2. ⏳ Manual testing needed: Run agent with tool-heavy conversation
3. ⏳ Verify emergency truncation logs appear for large results
4. ⏳ Confirm context doesn't exceed 200K tokens

---

## Related Issues

- **Issue 8 (CLAUDE.md):** Original tool result truncation fix (only handled strings in history)
- **Issue 9 (CLAUDE.md):** Gateway hang on startup (fixed 2026-02-20)

---

## Files Changed

- `src/gateway/services/AgentService.ts` (lines 610-686)
- `docs/TOOL_RESULT_OBJECT_TRUNCATION_FIX.md` (this file)

---

## Prevention

To prevent similar issues in the future:

1. **Always test with real tool outputs** (not just mock strings)
2. **Log tool result sizes** to catch large outputs early
3. **Type checks should be avoided** when handling `unknown` types - use type guards or handle all cases
4. **Test truncation logic** with both primitive and complex types

---

**Status:** ✅ Fixed (2026-03-03)  
**Verification:** Awaiting user testing with tool-heavy conversation
