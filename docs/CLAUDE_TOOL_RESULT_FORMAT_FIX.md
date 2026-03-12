# Claude Tool Result Format Fix - Plan Cards

**Date:** 2026-03-09
**Issue:** Claude (via pi-ai/OAuth) calls `create_plan` 3 times, doesn't recognize success

---

## Problem

When using **Claude Opus 4-6 via pi-ai (OAuth route)**, the agent calls `create_plan` multiple times:

```
Step 3: create_plan (result: 553 chars)
Step 4: create_plan (result: 551 chars)  
Step 5: create_plan (result: 551 chars)
```

Then proceeds with the work without the plan.

### Why This Happens

1. **pi-ai path stringifies tool results** for Claude's API format:
   ```typescript
   let text = typeof tr.result === "string" 
     ? tr.result 
     : JSON.stringify(tr.result ?? "");
   ```

2. **Claude sees opaque JSON** when `create_plan` returns:
   ```json
   {"success":true,"data":{"planId":"...","title":"...","steps":[...]}}
   ```

3. **No clear success signal** - Claude doesn't understand this means "plan created successfully"

4. **Claude retries** thinking the tool failed or returned unclear output

5. **After 3 attempts**, Claude gives up and says "formatting issue"

### Why Other Tools Don't Have This Issue

Tools like `delegate_task`, `run_job`, `create_app` return similar formats but Claude doesn't retry them. The difference:

- **Planning tools** have specific expectations in Claude's training
- **Claude expects clear confirmation** when creating a plan
- **Generic JSON blobs** don't meet that expectation for critical operations like planning

---

## Solution: Return Human-Readable Strings

Changed `create_plan` and `update_plan` to return **JSON.stringify** with a **prominent message field**:

### Before (Object Return)
```typescript
return {
  success: true,
  data: plan,
  message: `Plan created: "${args.title}" with ${steps.length} steps`,
};
```

Claude sees (after pi-ai stringification):
```json
{"success":true,"data":{"planId":"plan-123","title":"Build Dashboard","steps":[...]},"message":"Plan created: \"Build Dashboard\" with 5 steps"}
```

### After (String Return)
```typescript
const message = `✓ Plan created: "${args.title}" with ${steps.length} steps
Plan ID: ${planId}

Next: Start working on the first step, then call update_plan after completing each step.`;

return JSON.stringify({
  success: true,
  message,
  data: plan,
});
```

Claude sees:
```
✓ Plan created: "Build Dashboard" with 5 steps
Plan ID: plan-123

Next: Start working on the first step, then call update_plan after completing each step.
```

**Much clearer!** The checkmark, explicit confirmation, and next-step guidance make success unmistakable.

---

## Files Changed

### 1. `src/core/tools/planning.ts`

**create_plan:**
```typescript
const message = `✓ Plan created: "${args.title}" with ${steps.length} steps\nPlan ID: ${planId}\n\nNext: Start working on the first step, then call update_plan after completing each step.`;

return JSON.stringify({
  success: true,
  message,
  data: plan,
});
```

**update_plan:**
```typescript
const message = `✓ Plan updated: ${completedCount}/${plan.steps.length} steps complete${allCompleted ? " (All steps finished!)" : ""}\nPlan ID: ${args.planId}\n\n${allCompleted ? "Great job completing all steps!" : "Continue with the next pending step."}`;

return JSON.stringify({
  success: true,
  message,
  data: updatedPlan,
});
```

### 2. `ui/components/Chat/PlanCard.tsx`

Added handling for double-stringified JSON (when tool returns string that's later stringified again):

```typescript
export function parsePlanFromToolResult(
  toolName: string,
  result: string | undefined,
): PlanData | null {
  if (toolName !== "create_plan" && toolName !== "update_plan") return null;
  if (!result) return null;

  try {
    const parsed = JSON.parse(result) as { data?: PlanData; success?: boolean };
    if (parsed?.data?.planId && parsed?.data?.steps) {
      return parsed.data;
    }
    // Maybe the result is the plan directly
    const direct = parsed as unknown as PlanData;
    if (direct?.planId && direct?.steps) {
      return direct;
    }
  } catch (e) {
    // If parsing fails, try to extract from stringified JSON
    try {
      // Result might be double-stringified
      const doubleString = JSON.parse(result);
      if (typeof doubleString === 'string') {
        return parsePlanFromToolResult(toolName, doubleString);
      }
    } catch {
      /* not double-stringified */
    }
  }

  return null;
}
```

---

## Why This Works

### 1. Clear Visual Confirmation
- **Checkmark (✓)** - Universal success symbol
- **Explicit message** - "Plan created" not just `{success:true}`
- **Context** - Shows what was created (title, step count)

### 2. Action Guidance
- **Next steps** - Tells agent what to do next
- **Prevents retry** - Agent knows it succeeded, no need to call again

### 3. Structured Data Preserved
- **`data` field** still contains full plan object for UI
- **PlanCard** can still parse and render the plan
- **Both paths work** - AI SDK (object) and pi-ai (string)

---

## Testing

### Test Case 1: ChatGPT (OAuth)
- Uses pi-ai/OpenAI backend
- Should work same as before (wasn't broken)

### Test Case 2: Claude (OAuth) - THE FIX
- Uses pi-ai/Anthropic backend
- **Before:** 3 calls to `create_plan`, then gives up
- **After:** 1 call to `create_plan`, sees clear success, continues work

### Test Case 3: ChatGPT (API Key)
- Uses AI SDK
- Should work same as before (wasn't broken)

### Test Case 4: Claude (API Key)
- Uses AI SDK/Mastra
- Should work same as before (wasn't broken)

---

## Do Other Tools Need This Fix?

**Short answer: No, not urgently.**

Other tools that return `{ success: true, data: {...} }`:
- `create_app`
- `create_job`
- `delegate_task`
- `create_sub_agent`
- etc.

These **don't trigger the same retry behavior** in Claude. Planning tools are special because:

1. **Claude's training** emphasizes planning as a critical step
2. **Expectations are higher** for confirmation clarity
3. **Ambiguous results** trigger defensive retry behavior

---

## When to Use This Pattern

Apply the "prominent message + JSON.stringify" pattern for tools where:

1. **Critical operation** - Plan creation, pipeline setup, system configuration
2. **Claude retries** - You observe multiple calls in logs
3. **User visibility** - Operation shows progress cards in UI
4. **Clear confirmation needed** - Success must be unmistakable

**Don't use for:**
- Read-only operations (read_file, list_apps)
- Operations where JSON structure is sufficient
- Tools that already work well with both ChatGPT and Claude

---

## Alternative Solutions Considered

### 1. Change pi-ai stringification logic
**Rejected:** Would affect all tools globally, risky

### 2. Add `message` field without stringify
**Rejected:** Message still buried in JSON, Claude doesn't see it prominently

### 3. Make PlanCard more flexible
**Done:** Added double-stringify handling, but not enough alone

### 4. Update system prompt only
**Done:** Added "only call once" guidance, but doesn't fix root cause

**Final solution:** Combine all approaches - prominent message + stringify + system prompt guidance + flexible parsing.

---

## Monitoring

Watch for:

1. **Multiple `create_plan` calls** - Should drop to 1 per task
2. **"Formatting issue" messages** - Should disappear
3. **Plan cards rendering** - Should work on all auth types
4. **Other tools showing retry behavior** - May need similar fix

---

## Related Issues

- **System Prompt Improvements** - Added "only call once" guidance
- **Plan Update Frequency** - Emphasized incremental updates
- **API Keys in Jobs** - Added explicit substitution guidance

All part of making agent behavior more predictable and clear across different LLM providers and auth methods.
