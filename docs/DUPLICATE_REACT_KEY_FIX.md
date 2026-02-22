# Duplicate React Key Error Fix

**Date**: 2026-02-19  
**Status**: ✅ FIXED

## Problem

React warning in console:
```
Warning: Encountered two children with the same key, `job-inline-a4e9a3b4-09d3-4995-bfcd-a256cc139cef`. 
Keys should be unique so that components maintain their identity across updates.
```

This error occurred when rendering `JobStatusCard` components in the `ExploringCard`.

## Root Cause

In `MessageItem.tsx`, when rendering the sequence of tool calls, we were pushing `JobStatusCard` components into `exploringItems` **inside the loop** every time we encountered a `run_job` tool call:

```typescript
// BEFORE (lines 243-250)
if (runJobData) {
  exploringItems.push(
    <JobStatusCard
      key={`job-inline-${runJobData.jobId}`}
      data={runJobData}
    />,
  );
}
```

**Problem**: If the same job appeared multiple times in the sequence (e.g., once when called, once when finished), we would push a card with the **same key** multiple times, causing React's duplicate key error.

While we did use `jobStatusCardMap` to track the latest state of each job, we weren't using it to **deduplicate** the cards being added to `exploringItems`.

## Fix

Added tracking sets to ensure each job/delegation card is only added once:

```typescript
// Track which jobs/delegations we've already added to exploringItems (to prevent duplicates)
const addedJobIds = new Set<string>();
const addedDelegationIds = new Set<string>();
```

Then check before adding:

```typescript
// Job cards
if (runJobData) {
  // Only add if we haven't already added this jobId
  if (!addedJobIds.has(runJobData.jobId)) {
    exploringItems.push(
      <JobStatusCard
        key={`job-inline-${runJobData.jobId}`}
        data={runJobData}
      />,
    );
    addedJobIds.add(runJobData.jobId);
  }
}

// Delegation cards
if (delegationData) {
  // Only add if we haven't already added this delegation ID
  if (!addedDelegationIds.has(delegationData.id)) {
    exploringItems.push(
      <DelegationCard
        key={`delegation-${delegationData.id}`}
        data={delegationData}
      />,
    );
    addedDelegationIds.add(delegationData.id);
  }
}
```

## Impact

- ✅ No more React duplicate key warnings
- ✅ Each job/delegation card appears exactly once in the UI
- ✅ Cards still appear inline with other tools (interleaved, not grouped at end)
- ✅ Latest state of each job/delegation is shown (via `jobStatusCardMap`)

## Files Changed

- `ui/components/Chat/MessageItem.tsx` - Added deduplication tracking for job and delegation cards

## Why This Happens

When a tool is called, the sequence might contain:
1. Initial tool call (status: "calling", no result yet)
2. Tool result (status: "success", result present)

For `run_job` and `delegate_task`, we create cards for **both** states (placeholder when running, full card when finished). Without deduplication, we'd render both, causing duplicate keys.

The fix ensures we only render the **first occurrence** we encounter during the loop, which will be updated reactively by the stores (`jobLiveLogsStore` for live logs, status broadcasts for state changes).

## Testing

1. Create a job via `run_job` tool
2. Observe the job card appears immediately (with "Waiting for output..." or live logs)
3. Check browser console - no React key warnings
4. Verify card updates as job progresses (running → completed/failed)
5. Same test for `delegate_task` → delegation card

## Related Docs

- `docs/AGENT_JOB_LOG_BROADCAST_FIX.md` - Why logs now appear in UI
- `docs/DELEGATION_CARD_LIVE_LOGS.md` - How delegation cards work
