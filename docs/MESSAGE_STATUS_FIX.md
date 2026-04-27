# Message Status Display Fix

## Issue
When a user sends a new message while the agent is still responding, or clicks the stop button, the previous message continues to show "Working" status instead of indicating that it was stopped or finished.

## Root Cause
When the agent is stopped (via `handleStopAgent` in `ChatContainer`), the code was only updating the chat-level streaming states but not:
1. Finalizing the streaming message (setting `isStreaming: false`)
2. Updating tool call statuses from "calling" to stopped/error state

This caused the `WorkingCard` to continue displaying "Working" because:
- `message.isStreaming` remained `true`
- Tools with `status: "calling"` remained in that state
- `isExploring = message.isStreaming || hasCallingTool` was still `true`

## Solution

### 1. ChatContainer.tsx - handleStopAgent
Updated to:
- Find the currently streaming message
- Update any tools with "calling" status to "stopped" with error "Stopped by user"
- Update both `sequence` (V1-style) and `toolCalls` (fallback) formats
- Finalize the streaming message to set `isStreaming: false`

### 2. WorkingCard.tsx
Added `wasStopped` prop to distinguish between:
- "Working" - actively processing
- "Stopped" - manually stopped by user
- "Finished Working" - completed normally

### 3. ExploringCard.tsx
Updated to show dynamic status labels instead of hardcoded "Working":
- Detects stopped state from tool errors
- Shows "Stopped", "Working", or "Finished Working" appropriately

### 4. MessageItem.tsx
Updated to:
- Detect when a message was stopped by checking for "Stopped by user" errors
- Pass `wasStopped` prop to `WorkingCard`

## Testing

### Manual Testing Steps

1. **Test Stop Button:**
   - Start a conversation that triggers agent response
   - While agent is responding, click the stop button
   - Verify the status changes from "Working" to "Stopped"

2. **Test New Message Interruption:**
   - Start a conversation that triggers agent response
   - While agent is responding, type and send a new message
   - Verify the previous message status changes from "Working" to "Stopped"
   - Verify the new message is sent and processed

3. **Test Normal Completion:**
   - Start a conversation and let the agent complete normally
   - Verify the status shows "Finished Working" (not "Stopped")

4. **Test Both Rendering Paths:**
   - Test with messages using V1-style sequence rendering
   - Test with messages using fallback toolCalls rendering
   - Both should show proper status

## Files Changed
- `ui/components/Chat/ChatContainer.tsx` - Stop handler logic
- `ui/components/Chat/WorkingCard.tsx` - Added `wasStopped` prop and status display
- `ui/components/Chat/ExploringCard.tsx` - Dynamic status labels
- `ui/components/Chat/MessageItem.tsx` - Detect and pass stopped state

## User-Visible Changes
- When stopping an agent response, the message will now show "Stopped" instead of continuing to display "Working"
- More accurate status indication for in-progress, stopped, and completed work
