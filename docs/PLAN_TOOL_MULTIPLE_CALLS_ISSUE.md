# Plan Tool Issue: Multiple Calls & "Formatting Issue" Message

**Date:** 2026-03-09
**Issue:** Agent calls `create_plan` multiple times, sees "Plan created ✓" repeatedly, then says "Skipping the plan tool — it's having a formatting issue"

---

## Problem Analysis

### Symptoms
User observed:
```
Good — I have everything I need. Let me plan and execute this properly.

→ Plan created ✓
→ Plan created ✓
→ Plan created ✓

Skipping the plan tool — it's having a formatting issue. Let me just get on with the work.
```

### Root Cause
The agent is:
1. Calling `create_plan` multiple times in rapid succession
2. Each call **succeeds** and returns `{ success: true, data: {...} }`
3. UI shows "Plan created ✓" for each successful call
4. Agent sees multiple success messages and **misinterprets them as failures**
5. Agent concludes there's a "formatting issue" (there isn't!)
6. Agent gives up and skips planning entirely

**The tool is working correctly** - the problem is the agent doesn't understand it should only call it once.

---

## Why This Happens

### 1. No Clear "Already Created" Signal
The tool returns:
```json
{
  "success": true,
  "data": { "planId": "...", "title": "...", "steps": [...] }
}
```

But doesn't explicitly say "You've already created a plan, stop calling this."

### 2. Multiple Success Messages Look Like Errors
When the agent sees:
- "Plan created ✓"
- "Plan created ✓"
- "Plan created ✓"

It interprets this as "something is broken" rather than "I called this 3 times."

### 3. Generic Error Message From Agent
The agent itself generates the "formatting issue" message - it's not from our codebase. This is the agent's way of saying "I don't understand what's happening, so I'll stop trying."

---

## Solutions Implemented

### 1. Add Explicit Message Field to Tool Results

**File:** `src/core/tools/planning.ts`

**Before:**
```typescript
return {
  success: true,
  data: plan,
};
```

**After:**
```typescript
return {
  success: true,
  data: plan,
  message: `Plan created: "${args.title}" with ${steps.length} steps`,
};
```

For `update_plan`:
```typescript
return {
  success: true,
  data: updatedPlan,
  message: `Plan updated: ${completedCount}/${plan.steps.length} steps complete${allCompleted ? " (Plan finished!)" : ""}`,
};
```

**Why:** The explicit message makes it clearer what happened and provides context about the plan.

### 2. Update System Prompt - "Only Call Once" Guidance

**File:** `src/core/agents/SystemPrompt.ts` → `buildBehaviorSection()`

**Added:**
```typescript
**CRITICAL: Only call create_plan ONCE per task:**
- If you call `create_plan` and see "Plan created", DON'T call it again
- If you see multiple "Plan created" messages, you've called it too many times
- Just proceed with the work and use `update_plan` to mark progress
- One plan per task - don't create duplicates
```

**Why:** Explicit instruction not to retry the tool call if it already succeeded.

### 3. Update Tool Description

**File:** `src/core/tools/planning.ts` → `createPlanTool`

**Added to description:**
```
IMPORTANT: Only call this ONCE per task - if you see 'Plan created' in the result, don't call it again!
```

**Why:** The tool itself warns the agent not to call multiple times.

---

## How Success Messages Should Work

### Expected Flow:
1. Agent: "Let me create a plan"
2. Agent calls `create_plan({ title: "...", steps: [...] })`
3. Tool returns: `{ success: true, message: "Plan created: 'Build Feature' with 5 steps" }`
4. UI shows: "→ Plan created ✓"
5. Agent sees success → proceeds with first step
6. Agent calls `update_plan` after completing each step

### Previous (Broken) Flow:
1. Agent: "Let me create a plan"
2. Agent calls `create_plan(...)` 
3. Tool returns: `{ success: true, data: {...} }`
4. UI shows: "→ Plan created ✓"
5. Agent doesn't understand → retries
6. Agent calls `create_plan(...)` again
7. Tool returns: `{ success: true, data: {...} }` (creates another plan)
8. UI shows: "→ Plan created ✓"
9. Agent still confused → retries again
10. After 3+ attempts: "Skipping the plan tool — it's having a formatting issue"

---

## Testing Strategy

### Manual Testing
1. Ask agent to build a mini-app or multi-step task
2. Watch for `create_plan` calls in tool execution logs
3. **Expected:** One call to `create_plan`, then multiple `update_plan` calls
4. **Red flag:** Multiple `create_plan` calls with same title

### Automated Testing
Add test case:
```typescript
it('agent should only call create_plan once per task', async () => {
  // Given a multi-step task
  const response = await agent.chat("Build a dashboard with 5 features");
  
  // Count create_plan calls
  const planCalls = response.toolCalls?.filter(tc => tc.toolName === 'create_plan');
  
  // Should only be 1
  expect(planCalls).toHaveLength(1);
});
```

### Log Monitoring
Monitor for patterns:
- `create_plan` called >1 time in same conversation turn
- "Plan created" message appearing multiple times before first step
- Agent messages containing "formatting issue" or "skipping plan"

---

## Prevention Strategies

### 1. Idempotency Check (Future Enhancement)
Could add to `create_plan` tool:
```typescript
// Check if plan already exists for this chat with same title
const existing = await planService.getPlansByChat(chatId);
const duplicate = existing.find(p => 
  p.title === args.title && 
  p.status === 'active' && 
  // Created within last 60 seconds
  Date.now() - new Date(p.createdAt).getTime() < 60000
);

if (duplicate) {
  return {
    success: true,
    data: duplicate,
    message: `Plan already exists: "${duplicate.title}" (${duplicate.planId}). Use update_plan to modify it.`,
  };
}
```

### 2. Rate Limiting (Future Enhancement)
Track recent tool calls and warn/reject if same tool called multiple times rapidly:
```typescript
// In tool registry
const recentCalls = new Map<string, number>(); // toolId -> timestamp

if (recentCalls.has('create_plan')) {
  const lastCall = recentCalls.get('create_plan')!;
  if (Date.now() - lastCall < 5000) {
    throw new Error('create_plan was just called. Wait 5 seconds or use update_plan to modify existing plan.');
  }
}
```

### 3. UI Feedback Enhancement (Future Enhancement)
Show warning in UI when duplicate plans detected:
```tsx
{planMap.size > 1 && (
  <div className="plan-warning">
    ⚠️ Multiple plans created - you may want to consolidate these
  </div>
)}
```

---

## Related Issues

### Similar Patterns to Watch For
Other tools where agents might retry unnecessarily:
- `create_app` - Check if agent creates duplicate apps
- `create_job` - Check if agent creates duplicate jobs
- `create_document` - Check if agent creates duplicate documents

### Agent Confusion Signals
Watch for agent messages like:
- "having a formatting issue"
- "tool isn't working"
- "let me try a different approach"
- "skipping the tool"

When tools are actually succeeding but agent doesn't understand the result format.

---

## Files Changed

1. **`src/core/tools/planning.ts`**
   - Added `message` field to `create_plan` return value
   - Added `message` field to `update_plan` return value
   - Updated `createPlanTool` description with "ONCE per task" warning

2. **`src/core/agents/SystemPrompt.ts`**
   - Added "Only call create_plan ONCE" section to behavior guidance
   - Explicit instruction not to retry if already succeeded

3. **`docs/PLAN_TOOL_MULTIPLE_CALLS_ISSUE.md`** (this file)
   - Complete documentation of issue and solutions

---

## Success Metrics

After deployment, monitor:

1. **Plan Creation Rate:**
   - Avg plans per conversation
   - % of conversations with >1 plan
   - % of plans created within 5 seconds of each other (likely duplicates)

2. **Agent Confusion Indicators:**
   - Frequency of "formatting issue" in agent messages
   - Frequency of "skipping" tool mentions
   - Failed workflow completion rate

3. **Tool Call Patterns:**
   - Ratio of `create_plan` to `update_plan` calls (should be 1:N where N >= steps)
   - Time between `create_plan` and first `update_plan` (should be <30s typically)

---

## Conclusion

The issue wasn't a bug in the tool - the tool worked perfectly. The issue was:
1. Lack of explicit "don't call me twice" guidance
2. Generic success messages that didn't make it obvious what happened
3. Agent misinterpreting repeated success as failure

The fixes make success clearer and explicitly tell the agent not to retry successful tool calls.
