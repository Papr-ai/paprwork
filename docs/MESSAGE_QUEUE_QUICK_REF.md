# Message Queue - Quick Reference

## User Behavior

### When Agent is Responding

**First Enter/Send**: Queues the message
- Message goes into queue (shows "X Queued")
- Agent continues responding
- Input clears, ready for next message
- Placeholder changes to "Send follow-up..."

**Second Enter/Send** (within 2 seconds): Stops agent and sends immediately
- Agent response marked as "Stopped"
- Message sends immediately
- Bypasses queue

### Queue Display

**Collapsed** (default):
```
┌─────────────────────────────┐
│ 1 Queued                  ▼ │
│ which embedding model are... │
└─────────────────────────────┘
```

**Expanded** (click header):
```
┌─────────────────────────────────────┐
│ 1 Queued                          ▼ │
├─────────────────────────────────────┤
│ which embedding model are we using  │
│ for these?                          │
│ [Send now] [✕]                      │
└─────────────────────────────────────┘
```

### Actions

- **Click "Send now"**: Stops agent, sends that message immediately
- **Click ✕**: Removes message from queue
- **Wait**: Auto-sends when agent finishes (in order)

## Implementation Files

- `ui/components/Chat/QueuedMessages.tsx` - Queue UI component
- `ui/components/Chat/QueuedMessages.css` - Queue styling
- `ui/components/Chat/ChatContainer.tsx` - Queue state management
- `ui/components/Chat/InputBar.tsx` - Queue-aware send logic
- `ui/components/Chat/InputBar.css` - Margin adjustments

## Key Logic

### Double-Send Detection
```typescript
const timeSinceLastAttempt = now - lastSendAttemptRef.current;
if (timeSinceLastAttempt < 2000) {
  // Stop agent and send immediately
} else {
  // Queue the message
}
```

### Auto-Send Next
```typescript
useEffect(() => {
  if (!isSending && messageQueue.length > 0) {
    processNextQueued();
  }
}, [isSending, messageQueue.length]);
```

## Testing Checklist

- [ ] Queue message while agent responds
- [ ] Queue multiple messages in sequence
- [ ] Double-press Enter to send immediately
- [ ] Click "Send now" button on queued item
- [ ] Remove message from queue with ✕
- [ ] Verify auto-send when agent finishes
- [ ] Check placeholder changes to "Send follow-up..."
- [ ] Expand/collapse queue UI
- [ ] Verify stopped message shows "Stopped" status
