# Working Card Collapse Layout Fix

**Issue:** When the "Working" section is collapsed and contains a job card that's running, the entire chat interface scrolls up abnormally, with the message input being displaced from its normal position at the bottom.

**Date Fixed:** 2026-04-11

## Problem

When `WorkingCard` is collapsed:
- `max-height: 0px` hides the overflow
- `opacity: 0` makes it invisible
- **BUT** the content inside (like `JobStatusCard`) still affects the layout flow before being hidden
- This causes the chat container to expand unexpectedly, pushing the message input up

## Root Cause

The collapsed state used only `max-height: 0` and `opacity: 0`, but the content was still part of the normal document flow. When a job card or other content was rendered inside the collapsed WorkingCard, it would still reserve space in the layout even though it was visually hidden.

## Solution

Added a CSS class `working-card-content--collapsed` that:
1. Sets `visibility: hidden` to hide the content
2. Uses `position: absolute` to remove it from the document flow
3. Adds `pointer-events: none` to prevent any interaction

### Files Changed

**`ui/components/Chat/WorkingCard.tsx`:**
- Added conditional class `working-card-content--collapsed` when `isCollapsed` is true

**`ui/components/Chat/WorkingCard.css`:**
- Changed `overflow-y: auto` to `overflow: hidden` for consistent behavior
- Added `.working-card-content--collapsed` rule with layout fixes

## Technical Details

### Before
```css
.working-card-content {
  max-height: 420px;
  overflow-y: auto; /* Only vertical scroll */
  /* Content still in document flow when collapsed */
}
```

### After
```css
.working-card-content {
  max-height: 420px;
  overflow: hidden; /* Hide all overflow */
}

.working-card-content--collapsed {
  visibility: hidden;
  position: absolute; /* Remove from document flow */
  pointer-events: none; /* Disable interaction */
}
```

## Impact

- **Before:** Chat interface scrolls up when Working section is collapsed with job cards
- **After:** Working section collapse behaves correctly, no layout shift
- **User Experience:** Smooth collapse/expand without affecting chat container height

## Testing

1. Start a job that creates a JobStatusCard
2. Collapse the "Working" section while job is running
3. Verify chat interface remains stable
4. Verify message input stays at bottom
5. Expand "Working" section - verify content appears correctly

## Related Issues

- Similar to other collapse/expand animation issues where hidden content affects layout
- Pattern can be applied to other collapsible sections (ThinkingCard, ExploringCard)
