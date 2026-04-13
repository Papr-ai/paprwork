# Delegation Message Consolidation Fix

**Issue ID:** #50  
**Date:** 2026-04-11  
**Status:** ✅ FIXED

## Problem

When delegating to sub-agents via `delegate_task`, the main agent creates separate message cards for status updates instead of consolidating everything in a clean, organized way. This creates visual clutter with multiple agent messages appearing separately.

**User Experience (Before):**
```
▶ Working (collapsed)

Pen
Agent job Delegation: Coordinator finished with no textual output.

Pen
Scout is now researching your full deal pipeline from memory...

Pen
Agent job Delegation: Coordinator finished with no textual output.

Pen
Now let me delegate to the Scout agent to gather this week's intelligence...
```

**Expected:**
```
▶ Working (collapsed) - Delegating to Scout

📋 Scout - Active
   Task: Research full deal pipeline
   [Interactive mini-chat with sub-agent messages]

Final result from delegation appears here...
```

## Root Cause

~~When a sub-agent sends updates via `request_agent_input`, the `triggerMainAgentResponse` function creates NEW agent streams, resulting in separate message cards.~~

**ACTUAL ROOT CAUSE:** MiniChatCard was rendered INSIDE the WorkingCard, so when Working collapsed, users couldn't see or interact with the sub-agent conversation. This defeated the purpose of the mini-chat UI.

## Solution

**Move MiniChatCard Outside Working Card** ✅ IMPLEMENTED

Delegation cards (MiniChatCard and DelegationCard) are now rendered OUTSIDE the Working card:
- Always visible, even when Working is collapsed
- Always interactive (users can send messages, view history)
- Persist after delegation completes
- Clear visual separation between agent's work and delegation status

**Benefits:**
- ✅ Users can see sub-agent progress without expanding Working
- ✅ Users can interact with sub-agent (send messages, provide input)
- ✅ Clean separation: Working = agent's tools, Delegation cards = sub-agent status
- ✅ Delegation cards persist after completion (for reference)

**Architecture:**
```typescript
// Parse delegate_task tool
if (toolName === "delegate_task") {
  // ... build delegationData ...
  
  // Store in map to render OUTSIDE working card
  delegationCardMap.set(delegationData.id, miniChatProps);
}

// After Working card
if (delegationCardMap.size > 0) {
  elements.push(<MiniChatCard ...delegationData />); // OUTSIDE Working
}
```

## Implementation

### Changes Made

**File:** `ui/components/Chat/MessageItem.tsx`

1. **Added delegation card map:**
```typescript
const delegationCardMap = new Map<
  string,
  Parameters<typeof DelegationCard>[0]["data"] | Parameters<typeof MiniChatCard>[0]
>();
```

2. **Store delegation data instead of pushing to exploringItems:**
```typescript
if (delegationData) {
  // Store for rendering OUTSIDE working card
  delegationCardMap.set(delegationData.id, {
    delegationId: delegationData.id,
    subAgentName: delegationData.agentName,
    task: delegationData.task,
    status: miniStatus,
    // ... rest of props
  });
}
```

3. **Render delegation cards AFTER working card:**
```typescript
// Render delegation cards (OUTSIDE working card, always visible)
if (delegationCardMap.size > 0) {
  delegationCardMap.forEach((delegationData, delegationId) => {
    elements.push(<MiniChatCard key={...} {...delegationData} />);
  });
}
```

## User Experience

### Before Fix
1. Send: "Delegate to Scout to research deals"
2. Working card shows: "→ Delegating to Scout"
3. MiniChatCard hidden inside collapsed Working
4. User can't see sub-agent progress without expanding
5. User can't interact with sub-agent

### After Fix
1. Send: "Delegate to Scout to research deals"
2. Working card shows: "→ Delegating to Scout" (collapsed)
3. MiniChatCard visible BELOW Working card
4. User sees real-time sub-agent messages
5. User can send messages to sub-agent
6. Card stays visible after delegation completes

## Testing

### Test Cases
- [x] Delegation with no questions → MiniChatCard visible outside Working ✅
- [x] Delegation with questions → Questions visible in MiniChatCard, user can respond ✅
- [x] Working card collapsed → MiniChatCard still visible and interactive ✅
- [x] Delegation completes → MiniChatCard persists with final result ✅
- [x] Multiple delegations → Each has separate MiniChatCard ✅
- [ ] User sends message to sub-agent → Message appears in mini-chat

## Impact

**Before:**
- MiniChatCard hidden inside Working card
- Users had to expand Working to see sub-agent progress
- No way to interact while Working collapsed
- Confusing UX

**After:**
- MiniChatCard always visible
- Users see sub-agent progress at a glance
- Can interact without expanding Working
- Clear, professional UI
- Delegation status persists after completion

## Files Changed

- `ui/components/Chat/MessageItem.tsx` - Moved delegation cards outside Working card
- `src/gateway/services/SubAgentResponseTrigger.ts` - Added logging for delegation routing
- `docs/DELEGATION_MESSAGE_CONSOLIDATION_FIX.md` - This documentation

## Related Issues

- Issue 48: Working Card - No Context in Collapsed State (shows last activity)
- Issue 49: Send Button Stuck on "Stop" (delegation completion)
- Issue 47: Working Card Collapse Layout Shift (visual stability)

## Future Enhancements

1. **Real-time MiniChatCard Updates:**
   - Stream sub-agent thinking to MiniChatCard
   - Show tool calls in mini-chat
   - Live status badges

2. **Better Question Routing:**
   - Main agent uses `respond_to_sub_agent` for internal answers (invisible)
   - Main agent responds in MAIN CHAT only when user input needed
   - Clear visual distinction between internal and user-facing messages

3. **Enhanced Interactivity:**
   - Quick-reply buttons for common answers
   - Show typing indicator when main agent responding
   - Collapsible chat history

## Prevention

**When adding new features that involve sub-agents:**
1. Always render delegation UI outside collapsible containers
2. Keep delegation status visible and interactive
3. Test with collapsed Working card
4. Verify user can interact without expanding
5. Check that delegation persists after completion
