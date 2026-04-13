# Working Card Last Activity Display

**Issue:** When WorkingCard is collapsed (default state), users have no visibility into what the agent is doing or what job is running. The collapsed header just shows "Working" with no context, making it unclear if the agent is still active, stuck, or waiting for a long-running job.

**Date Fixed:** 2026-04-11

## Problem

**User Experience Issue:**
1. WorkingCard starts collapsed by default
2. Agent performs tools and launches jobs - all hidden
3. User sees multiple collapsed "Working" headers with no indication of:
   - What the agent is currently doing
   - Which job is running
   - Whether the agent is still active or waiting
   - How long things have been running

**Result:** Confusion and uncertainty - users don't know if they should wait, expand to check, or if something is stuck.

## Solution

Display the **last activity** (most recent tool call or text) directly in the collapsed header.

### Implementation

**1. WorkingCard Component:**
- Added `lastActivity?: string` prop
- Display `lastActivity` instead of hardcoded "Working" text
- CSS updated to handle longer text with ellipsis

**2. MessageItem Logic:**
- Extract last activity from sequence (most recent tool or text)
- Special handling for `run_job` to show job name
- Pass to WorkingCard via `lastActivity` prop

**3. Activity Types:**
- **Tools:** Use `getToolDisplayLabel()` for nice formatting
  - Example: "Reading file", "Querying database", "Creating app"
- **run_job:** Special case shows job name
  - Running: "Running job: People Verify"
  - Complete: "Job finished: People Verify"
- **Text:** First 50 chars of agent response
  - Example: "I've completed the search and found 3 results..."

### Examples

**During agent work:**
```
▶ Querying data.db 3s
```

**When job starts:**
```
▶ Running job: People Verify 5s
```

**After agent finishes, job still running:**
```
▶ Running job: People Verify 12s
```
(Note: Timer continues)

**When everything completes:**
```
▶ Job finished: People Verify ✓ 15s
```
(Note: Timer stops, checkmark appears)

## Files Changed

**`ui/components/Chat/WorkingCard.tsx`:**
- Added `lastActivity` prop
- Display `lastActivity || "Working"` in header

**`ui/components/Chat/WorkingCard.css`:**
- Added `flex: 1`, `overflow: hidden`, `text-overflow: ellipsis` to `.working-label-text`

**`ui/components/Chat/MessageItem.tsx`:**
- Extract last activity from sequence
- Special handling for `run_job` to show job name
- Pass `lastActivity` to WorkingCard

## Impact

- **Before:** Collapsed header shows generic "Working" - no context
- **After:** Collapsed header shows exact current activity - full transparency
- **User Experience:** 
  - Always know what's happening without expanding
  - See job names and status
  - Clear indication when waiting vs. active work
  - Timer shows total elapsed time

## Technical Details

### Activity Extraction Logic

```typescript
// Find last tool or text in sequence
for (let i = sequence.length - 1; i >= 0; i--) {
  const item = sequence[i];
  if (item.type === "tool") {
    if (toolName === "run_job") {
      // Show job name
      lastActivity = `Running job: ${jobName}`;
    } else {
      // Use standard tool display label
      lastActivity = getToolDisplayLabel(toolCall);
    }
    break;
  } else if (item.type === "text") {
    // Show first 50 chars of text
    lastActivity = text.substring(0, 50) + "...";
    break;
  }
}
```

### CSS Handling

```css
.working-label-text {
  font-weight: 600;
  color: var(--text-color);
  flex: 1; /* Take remaining space */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap; /* Prevent wrapping */
}
```

## Benefits

1. ✅ **Transparency:** User always sees current activity
2. ✅ **Context:** Job names visible without expanding
3. ✅ **Status clarity:** Know if agent is working vs. waiting
4. ✅ **No interaction required:** Information at a glance
5. ✅ **Scales well:** Works for any tool or activity type

## Related Issues

- Issue 47: Working Card Collapse Layout Shift
- Jobs showing "running" state without visible context
