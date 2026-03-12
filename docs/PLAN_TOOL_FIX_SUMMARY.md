# Summary: Plan Tool Fix - "Only Call Once" Guidance

**Date:** 2026-03-09
**Issue:** Agent calling `create_plan` multiple times, seeing "Plan created ✓" repeatedly, then saying "formatting issue"

---

## Quick Summary

**Problem:** Agent calls `create_plan` 3+ times, each succeeds, agent misinterprets repeated success as failure, gives up.

**Root Cause:** No explicit guidance that tool should only be called once per task.

**Solution:** 
1. Added explicit "Only call ONCE" guidance to system prompt
2. Added descriptive `message` field to tool results
3. Updated tool description with "don't call again" warning

---

## Changes Made

### 1. System Prompt - Added "Only Call Once" Section

**File:** `src/core/agents/SystemPrompt.ts` → Line ~790

**Added:**
```typescript
**CRITICAL: Only call create_plan ONCE per task:**
- If you call `create_plan` and see "Plan created", DON'T call it again
- If you see multiple "Plan created" messages, you've called it too many times
- Just proceed with the work and use `update_plan` to mark progress
- One plan per task - don't create duplicates
```

### 2. Tool Results - Added Descriptive Messages

**File:** `src/core/tools/planning.ts`

**create_plan result:**
```typescript
return {
  success: true,
  data: plan,
  message: `Plan created: "${args.title}" with ${steps.length} steps`,
};
```

**update_plan result:**
```typescript
return {
  success: true,
  data: updatedPlan,
  message: `Plan updated: ${completedCount}/${plan.steps.length} steps complete${allCompleted ? " (Plan finished!)" : ""}`,
};
```

### 3. Tool Description - Added Warning

**File:** `src/core/tools/planning.ts` → Line ~63

**Added to description:**
```
IMPORTANT: Only call this ONCE per task - if you see 'Plan created' in the result, don't call it again!
```

---

## Expected Behavior After Fix

### Before (Broken):
```
Agent: "Let me create a plan"
→ Plan created ✓
→ Plan created ✓
→ Plan created ✓
Agent: "Skipping the plan tool — it's having a formatting issue"
```

### After (Fixed):
```
Agent: "Let me create a plan"
→ Plan created: "Build Dashboard" with 5 steps ✓
Agent: "Now let me start with step 1..."
[completes step 1]
→ Plan updated: 1/5 steps complete ✓
[completes step 2]
→ Plan updated: 2/5 steps complete ✓
...
```

---

## Testing

### Manual Test:
1. Ask agent: "Build a mini-app with multiple features"
2. Watch tool calls
3. **Expected:** ONE `create_plan` call, then multiple `update_plan` calls
4. **Red flag:** Multiple `create_plan` calls

### What to Monitor:
- Frequency of "formatting issue" messages (should drop to 0)
- Multiple "Plan created" messages in same turn (should drop to 0)
- Plans created within 5 seconds of each other (likely duplicates)

---

## Files Changed

1. `src/core/tools/planning.ts` - Added messages, updated description
2. `src/core/agents/SystemPrompt.ts` - Added "Only call ONCE" guidance
3. `docs/PLAN_TOOL_MULTIPLE_CALLS_ISSUE.md` - Complete analysis
4. `docs/PLAN_TOOL_FIX_SUMMARY.md` - This file

---

## Why This Matters

Plans are a key UX feature:
- Show users real-time progress
- Help users understand what's happening
- Allow interrupting and resuming work
- Professional workflow visibility

When agents skip plans due to confusion, users lose this visibility and the experience feels less professional.

The fix ensures agents understand that:
1. One call creates one plan
2. Multiple success messages = you called it too many times
3. Use `update_plan` for progress tracking

---

## Related: API Keys in Jobs & Plan Updates

This fix is part of a larger system prompt improvement effort:

1. **API Keys in Jobs** - Added guidance on `${KEY_NAME}` substitution
2. **Incremental Plan Updates** - Emphasized updating after each step
3. **Only Call Once** - This fix (prevents duplicate plan creation)

All three issues stem from agents not having clear enough guidance in the system prompt. The pattern for fixes:

1. Add explicit examples with ✅/❌
2. Use clear language ("ONCE", "DON'T call again")
3. Add context to tool results (`message` field)
4. Reinforce in multiple places (tool description + system prompt)
