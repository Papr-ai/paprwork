# Message Queue Implementation

## Overview
Implemented a message queue system that allows users to queue messages while the agent is responding, instead of immediately interrupting the response.

## User Experience

### Queueing a Message
When the agent is responding and the user types a new message:
1. **First press of Enter (or click Send)**: Message gets added to the queue
2. Queue displays above the input bar showing "X Queued" messages
3. User can continue typing and queuing more messages

### Sending Immediately (Interrupt)
To stop the agent and send a queued message immediately:
1. **Press Enter twice** (within 2 seconds), or
2. **Click Send button twice** (within 2 seconds), or
3. **Click "Send now"** button on a queued message

This will:
- Stop the current agent response
- Mark it as "Stopped"
- Send the selected message immediately

### Auto-Send Queue
When the agent finishes responding:
- The next queued message automatically sends
- Process continues until queue is empty
- No user action required

### Queue Management
Users can:
- **View queued messages**: Click on "X Queued" header to expand/collapse
- **Send specific message now**: Click "Send now" button (stops agent and sends)
- **Remove from queue**: Click ✕ button on any queued message
- **See preview**: When collapsed, shows preview of first queued message

## Implementation Details

### Components

#### 1. QueuedMessages Component
**File**: `ui/components/Chat/QueuedMessages.tsx`

Props:
- `queue: QueuedMessage[]` - Array of queued messages
- `onSendNow: (messageId: string) => void` - Callback to send message immediately
- `onRemove: (messageId: string) => void` - Callback to remove message from queue

Features:
- Collapsible UI showing queue count
- Preview of first message when collapsed
- Expanded view with all queued messages
- Action buttons for each message (Send now, Remove)

#### 2. ChatContainer Updates
**File**: `ui/components/Chat/ChatContainer.tsx`

New state:
```typescript
const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
const isProcessingQueue = useRef(false);
```

New handlers:
- `handleQueueMessage`: Adds message to queue
- `handleSendQueuedNow`: Stops agent and sends specific queued message
- `handleRemoveQueued`: Removes message from queue
- `processNextQueued`: Automatically sends next message when agent finishes

Auto-send effect:
```typescript
useEffect(() => {
  if (!isSending && messageQueue.length > 0) {
    processNextQueued();
  }
}, [isSending, messageQueue.length, processNextQueued]);
```

#### 3. InputBar Updates
**File**: `ui/components/Chat/InputBar.tsx`

New props:
- `onQueue?: (message: string, context?: Artifact[]) => void`

Enhanced send logic:
```typescript
const handleSend = () => {
  if (isSending) {
    const timeSinceLastAttempt = now - lastSendAttemptRef.current;
    
    if (timeSinceLastAttempt < 2000) {
      // Double-send within 2 seconds: stop and send immediately
      onStop();
      onSend(message, context);
    } else {
      // First attempt: queue the message
      onQueue(message, context);
      lastSendAttemptRef.current = now;
    }
  } else {
    // Agent not working: send normally
    onSend(message, context);
  }
};
```

### Types

```typescript
export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: number;
}
```

### Styling

**Files**:
- `ui/components/Chat/QueuedMessages.css` - Queue component styles
- `ui/components/Chat/InputBar.css` - Added margin adjustments

Design:
- Matches liquid glass theme
- Positioned above InputBar with 8px gap
- Collapsible header with chevron
- Hover effects on action buttons
- Dark mode support

## Edge Cases Handled

1. **Queue processing during new send**: Uses `isProcessingQueue` ref to prevent race conditions
2. **Multiple rapid sends**: 2-second window prevents accidental interrupts
3. **Agent stops during queue**: Auto-send still works when agent finishes
4. **Empty queue**: Component doesn't render if queue is empty
5. **Context artifacts**: Queue preserves both message text and context

## Testing Scenarios

### 1. Basic Queue
- Start agent response
- Type and send new message → should queue
- Wait for agent to finish → queued message auto-sends

### 2. Double-Send Interrupt
- Start agent response
- Type message and press Enter → queues
- Press Enter again within 2s → stops agent and sends immediately

### 3. Multiple Messages in Queue
- Start agent response
- Queue message #1
- Queue message #2
- Queue message #3
- Wait → all send automatically in order

### 4. Send Now Button
- Start agent response
- Queue several messages
- Click "Send now" on 2nd message → stops agent, sends that message, others remain queued

### 5. Remove from Queue
- Queue multiple messages
- Click ✕ to remove one → removed from queue, others remain

### 6. Context Preservation
- Attach files to message
- Queue message → files should be preserved
- When auto-sent → files should be included

## Future Enhancements

Potential improvements:
1. Persist queue to local storage (survive app restart)
2. Reorder queue via drag-and-drop
3. Edit queued messages before sending
4. Show queue across multiple chat tabs
5. Queue analytics (how often users queue vs interrupt)
6. Visual feedback when double-send is detected

## Files Changed
- `ui/components/Chat/QueuedMessages.tsx` (new)
- `ui/components/Chat/QueuedMessages.css` (new)
- `ui/components/Chat/ChatContainer.tsx` (queue state and handlers)
- `ui/components/Chat/InputBar.tsx` (queue-aware send logic)
- `ui/components/Chat/InputBar.css` (margin adjustments)
