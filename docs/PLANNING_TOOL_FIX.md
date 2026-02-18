# Planning Tool Fix

**Date:** 2026-02-17  
**Issue:** Agent wasn't creating plans for apps despite system prompt instructions

## Problem

The planning tools were registered and enabled, but the agent never used them because the **system prompt examples had the wrong schema**.

### System Prompt Examples (WRONG)
```javascript
create_plan({
  title: "Build App",
  steps: [
    { id: "check", title: "Check existing apps", status: "pending" }  // ❌ "title" field
  ]
})
```

### Actual Tool Schema (CORRECT)
```typescript
const planStepSchema = z.object({
  id: z.string().min(1).describe("Unique step identifier"),
  description: z.string().min(1).describe("Step description"),  // ✅ "description" field
});
```

The mismatch caused **validation failures** when the agent tried to call `create_plan`, so it stopped trying.

## Root Cause

Two locations in `SystemPrompt.ts` had incorrect examples:
1. Line 800-816: App Creation Reminder Section  
2. Line 878-896: App Creation Playbook Section

Both used `title` for step properties instead of `description`.

## Solution

Fixed both examples to match the actual tool schema:

```javascript
// ✅ CORRECT
create_plan({
  title: "Build [App Name] Mini-App",
  steps: [
    { id: "check", description: "Check existing apps" },
    { id: "load_docs", description: "Load agent-docs & design system" },
    { id: "design", description: "Design UI following Liquid Glass" },
    { id: "prototype", description: "Create mockup with placeholder data" },
    { id: "validate", description: "Validate data sources" },
    { id: "implement", description: "Build real app with live data" },
    { id: "test", description: "Test all UX states" }
  ]
})
```

Also clarified that:
- Steps are created with "pending" status automatically (don't need to specify)
- Updates use `update_plan({ planId: "...", updates: [{ stepId: "...", status: "..." }] })`

## Files Changed

- `src/core/agents/SystemPrompt.ts` (lines 792-816, 878-896)

## Verification

To verify the fix works:

1. Start the app: `npm start`
2. Ask the agent to build a mini-app: "Build me a weather tracker app"
3. Verify the agent creates a plan with visible progress cards in the UI
4. Check the plan has the correct schema:
   - Plan has `title` and `steps` array
   - Each step has `id` and `description` (not `title`)
   - Steps auto-default to "pending" status

## Related Files

- `src/core/tools/planning.ts` - Tool implementation and schema
- `src/gateway/services/PlanService.ts` - SQLite persistence
- `src/core/agents/SystemPrompt.ts` - System prompt with examples (fixed)

## Lessons Learned

1. **Schema Validation Matters:** When tools fail validation silently, the agent just stops using them
2. **Keep Examples in Sync:** System prompt examples must match actual tool schemas exactly
3. **Test Tool Usage:** Create integration tests that verify the agent can actually call tools successfully
4. **Document Schema Changes:** If tool schemas change, audit all system prompt examples
