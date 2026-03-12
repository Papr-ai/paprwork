# Plan Tool Schema Issue: Steps as String Instead of Array

**Date:** 2026-03-09
**Issue:** Claude passes `steps` parameter as string instead of array, causing validation errors

---

## Problem

When Claude calls `create_plan`, it sometimes passes the `steps` parameter as a **string** instead of an **array of objects**:

```
"steps: Invalid input: expected array, received string"
```

### What Claude Did (Wrong)

```javascript
create_plan({
  title: "Fix Settings",
  steps: "1. Update HTML\n2. Update CSS\n3. Update TypeScript"  // ❌ STRING!
})
```

### What It Should Do (Correct)

```javascript
create_plan({
  title: "Fix Settings",
  steps: [
    { id: "html", description: "Update HTML" },
    { id: "css", description: "Update CSS" },
    { id: "ts", description: "Update TypeScript" }
  ]  // ✅ ARRAY of objects
})
```

---

## Root Cause

The Zod schema descriptions were too minimal:

```typescript
steps: z.array(planStepSchema).min(1).describe("Ordered plan steps"),
```

Claude didn't understand that:
1. Steps must be an **array**, not a string
2. Each step must be an **object** with `id` and `description` fields
3. The format is specific, not free-form

---

## Solution: Enhanced Schema Descriptions

### 1. Updated Zod Schema Descriptions

**File:** `src/core/tools/planning.ts`

```typescript
const planStepSchema = z.object({
  id: z.string().min(1).describe("Unique step identifier (e.g., 'load_docs', 'create_ui')"),
  description: z.string().min(1).describe("Step description (e.g., 'Load design system and docs')"),
});

const createPlanSchema = z.object({
  chatId: z
    .string()
    .min(1)
    .optional()
    .describe("Chat ID (auto-detected if not provided)"),
  title: z.string().min(1).describe("Plan title (e.g., 'Build Dashboard App')"),
  steps: z.array(planStepSchema).min(1).describe(
    "Array of step objects. Each step must be an object with 'id' and 'description' fields. " +
    "Example: [{ id: 'design', description: 'Design UI' }, { id: 'build', description: 'Build components' }]"
  ),
});
```

### 2. Added Example to Tool Description

```typescript
description:
  "REQUIRED for any multi-step task... " +
  "Example usage: create_plan({ title: 'Build Dashboard', steps: [{ id: 'design', description: 'Design UI layout' }, { id: 'build', description: 'Build components' }] })"
```

### 3. Added Example to System Prompt

**File:** `src/core/agents/SystemPrompt.ts` → App Creation Reminder

```typescript
**CRITICAL: Steps must be an array of objects, not a string!**

✅ **CORRECT:**
```javascript
create_plan({
  title: "Build Dashboard",
  steps: [
    { id: "design", description: "Design UI layout" },
    { id: "build", description: "Build components" },
    { id: "test", description: "Test functionality" }
  ]
})
```

❌ **WRONG:**
```javascript
create_plan({
  title: "Build Dashboard",
  steps: "1. Design UI\n2. Build components\n3. Test"  // String not allowed!
})
```
```

---

## Why This Happens

### Claude's Natural Tendency

Claude (and other LLMs) naturally think of plans as **numbered lists** or **text outlines**:

```
1. First step
2. Second step
3. Third step
```

When they see a `steps` parameter without explicit structure guidance, they default to this string format.

### ChatGPT Comparison

ChatGPT seems better at inferring structured data from minimal schema descriptions. Claude needs more explicit examples.

---

## Testing

### Before Fix
```
create_plan called → Validation error: "expected array, received string"
→ Plan created ✗ (error)
→ Plan created ✗ (error)  
→ Plan created ✗ (error)
Agent: "Let me just build it" (gives up on planning)
```

### After Fix
```
create_plan called → Success
→ Plan created ✓
Agent continues with first step, updates plan after each step
```

---

## Related Issues

This is part of the larger **Claude-specific tool formatting** issues:

1. **Plan Tool Multiple Calls** - Solved with prominent success messages
2. **Plan Result Format** - Solved with JSON.stringify
3. **Plan Schema Validation** - This fix (explicit array structure)

All three were needed to make planning work reliably with Claude OAuth.

---

## Lessons Learned

### 1. Schema Descriptions Matter

For Claude:
- ✅ Explicit structure: "Array of objects with 'id' and 'description' fields"
- ✅ Examples in descriptions: `[{ id: 'x', description: 'y' }]`
- ❌ Minimal descriptions: "Ordered plan steps"

### 2. Tool Description Examples

Include example usage in the tool description itself:
```typescript
description: "Creates a plan. Example: create_plan({ title: 'X', steps: [{...}] })"
```

### 3. System Prompt Reinforcement

Show ✅ correct and ❌ wrong patterns in system prompt:
- Visual contrast helps
- Explicit "not allowed" statements
- Real code examples, not pseudocode

### 4. Provider Differences

Different LLMs need different levels of hand-holding:
- **ChatGPT**: Good at inferring structure from minimal schemas
- **Claude**: Needs explicit structure guidance and examples
- **Qwen**: May need even more explicit guidance (TBD)

---

## Future Prevention

### 1. Schema Design Checklist

For any tool with structured parameters:
- [ ] Add examples to field descriptions
- [ ] Include structure hints ("Array of objects with X and Y fields")
- [ ] Show example usage in tool description
- [ ] Add ✅/❌ examples to system prompt if critical

### 2. Validation Error Handling

Consider adding helpful error messages:
```typescript
if (typeof args.steps === 'string') {
  throw new Error(
    'Steps must be an array of objects, not a string. ' +
    'Example: [{ id: "step1", description: "Do thing" }]'
  );
}
```

This gives Claude immediate feedback to correct itself.

### 3. Auto-Correction

Could add auto-correction for common mistakes:
```typescript
// If steps is a string, try to parse it
if (typeof args.steps === 'string') {
  const lines = args.steps.split('\n');
  args.steps = lines.map((line, i) => ({
    id: `step${i+1}`,
    description: line.replace(/^\d+\.\s*/, '').trim()
  }));
}
```

But this masks the problem - better to make schema clear.

---

## Files Changed

1. **`src/core/tools/planning.ts`**
   - Enhanced schema descriptions with examples
   - Added example usage to tool description

2. **`src/core/agents/SystemPrompt.ts`**
   - Added ✅/❌ example in app creation reminder

3. **`ui/components/Chat/PlanCard.tsx`**
   - Added console logging for debugging
   - Improved error messages

4. **`docs/PLAN_SCHEMA_VALIDATION_ISSUE.md`** (this file)

---

## Success Metrics

After deployment:
- **Validation error rate**: % of `create_plan` calls that fail schema validation (target: <5%)
- **Plan creation success**: % of multi-step tasks that create plans (target: >90%)
- **Agent abandonment**: % of times agent says "let me just build it" after plan failures (target: <5%)

---

## Related Documentation

- `docs/CLAUDE_TOOL_RESULT_FORMAT_FIX.md` - JSON.stringify for success messages
- `docs/PLAN_TOOL_MULTIPLE_CALLS_ISSUE.md` - "Only call once" guidance
- `docs/SESSION_SUMMARY_SYSTEM_PROMPT_IMPROVEMENTS.md` - Complete session overview
