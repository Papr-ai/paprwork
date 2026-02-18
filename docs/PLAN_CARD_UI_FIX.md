# Plan Card UI Fix

**Date:** 2026-02-17  
**Issue:** Plan cards were not showing in the chat UI despite plans being created successfully

## Problem

When the agent called `create_plan` successfully:
- ✅ Plan was created in the database (`~/PAPR/data/plans.db`)
- ✅ Tool returned success with plan data
- ✅ Backend showed "create_plan ✓"
- ❌ UI did not show the plan card

### Root Cause

The `renderSequence` function in `MessageItem.tsx` did NOT extract and render plan cards from `create_plan`/`update_plan` tool results.

The UI had two rendering paths:
1. **Sequence path** (lines 252-254) - Used for messages with V1-style sequence format
2. **Fallback path** (lines 265-272) - Used for old format messages

Plan card extraction was **only** in the fallback path:

```typescript
// FALLBACK PATH ONLY
{!isUser &&
  message.toolCalls
    ?.map((tc) => parsePlanFromToolResult(tc.toolName, tc.result))
    .filter(Boolean)
    .map((plan) => plan ? <PlanCard key={plan.planId} data={plan} /> : null)
}
```

But current messages use the **sequence path**, which didn't check for plans.

## Solution

Added plan card extraction to the `renderSequence` function:

### 1. Extract Plan Data from Tool Results

```typescript
const planCards: React.ReactNode[] = [];

sequence.forEach((item, index) => {
  // ... existing code ...
  
  else if (item.type === 'tool') {
    const toolData = item.data as any;
    const toolCall = {
      // ... build toolCall object ...
    };
    
    // NEW: Check if this is a plan tool and extract plan data
    const toolName = toolData.name;
    if ((toolName === 'create_plan' || toolName === 'update_plan') && toolCall.result) {
      const planData = parsePlanFromToolResult(
        toolName, 
        typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result)
      );
      if (planData) {
        planCards.push(<PlanCard key={`plan-${planData.planId}`} data={planData} />);
      }
    }
    
    // ... render tool in exploring card ...
  }
});
```

### 2. Render Plan Cards Before Exploring Card

```typescript
// NEW: Render plan cards before exploring card
if (planCards.length > 0) {
  elements.push(...planCards);
}

// Render exploring card with all interleaved items
if (exploringItems.length > 0) {
  elements.push(
    <div key="exploring" className="exploring-card">
      {/* ... */}
    </div>
  );
}
```

### 3. Add Tool Display Names

```typescript
const toolDescriptions: Record<string, { running: string; complete: string }> = {
  // ... existing tools ...
  'create_plan': { running: 'Creating plan', complete: 'Plan created' },
  'update_plan': { running: 'Updating plan', complete: 'Plan updated' },
};
```

## Result

Now when the agent creates a plan:
1. ✅ Plan card shows above the Exploring card
2. ✅ Shows plan title and progress (0/15 steps)
3. ✅ Shows all steps with status icons (○ = pending, ◉ = in progress, ✓ = completed)
4. ✅ Collapsible to save space
5. ✅ Updates live when agent calls `update_plan`

## Files Changed

- `ui/components/Chat/MessageItem.tsx` (lines 79-148)
  - Added `planCards` array
  - Extract plan data from create_plan/update_plan tools
  - Render plan cards before exploring card
  - Added tool display names for plan tools

## Testing

To verify the fix:

1. Restart the app: `npm start`
2. Ask agent to build something: "Build me a habit tracker app"
3. Verify you see:
   - Plan card with title and progress bar
   - All steps listed with pending (○) status
   - Collapsible/expandable card
4. As agent works, verify plan updates with completed (✓) steps

## Related Components

- `ui/components/Chat/PlanCard.tsx` - Plan card component (already existed, working)
- `ui/components/Chat/PlanCard.css` - Styles (already existed, working)
- `src/core/tools/planning.ts` - Backend tool (already working)
- `src/gateway/services/PlanService.ts` - Storage (already working)

## Lessons Learned

1. **Dual rendering paths:** When adding new features, check ALL rendering paths in the UI
2. **Sequence vs Fallback:** V1-style sequence rendering is the primary path now
3. **Tool result extraction:** Any special tool that needs custom UI must be handled in sequence renderer
4. **Test end-to-end:** Don't assume because backend works, UI will automatically work
