# Working Card Timer - Client-Side Timestamp Implementation

## Problem
The timer in the WorkingCard component was showing inconsistent behavior:
- Timer appeared "stuck" when switching tabs
- Updates were sporadic (every 6-20 seconds)
- Depended on when WebSocket chunks arrived, not actual elapsed time

## Root Cause
Original implementation sent `elapsedSeconds` from backend with each chunk, but chunks don't arrive at regular intervals:
- Text chunks: Every 50ms to few seconds (batched)
- Tool calls: Sparse (only when tools execute)
- Tool results: Sparse (only when tools complete)

Result: Timer only updated when chunks arrived, appearing frozen between chunks.

## Solution: Client-Side Timestamp-Based Timer

### Architecture
**Client-side timing with streaming state control:**
1. When `isExploring` becomes `true` → Record `workStartTime = Date.now()`
2. Start `setInterval(1000)` that calculates: `elapsed = Date.now() - workStartTime`
3. When `isExploring` becomes `false` → Stop interval, keep final time

### Key Benefits

✅ **Smooth updates**: Timer advances every 1 second, no stuttering
✅ **Tab switching**: Works across tab switches via timestamp calculation
✅ **No backend load**: Zero WebSocket overhead
✅ **Accurate**: Timestamp math is always correct, regardless of interval throttling

### How It Handles Edge Cases

**Tab Switching:**
- Browser throttles `setInterval` when tab not visible (once per minute)
- But calculation is timestamp-based: `Date.now() - workStartTime`
- When you return to tab, next interval fires and shows correct elapsed time
- No "catching up" needed - it's just math

**Computer Sleep:**
- When computer sleeps, Gateway WebSocket disconnects
- `isExploring` becomes `false` (connection lost)
- Timer stops automatically
- Includes sleep time if `isExploring` stays true (but Gateway should disconnect)

**Multiple Chats:**
- Each WorkingCard component has its own timer state
- Independent timers per chat
- No shared state or race conditions

### Implementation Details

**WorkingCard.tsx:**
```typescript
const [elapsedTime, setElapsedTime] = useState(0);
const workStartTimeRef = useRef<number | null>(null);
const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

useEffect(() => {
  if (isExploring && !workStartTimeRef.current) {
    // Record when work started
    workStartTimeRef.current = Date.now();
    
    // Update timer every second using timestamp calculation
    timerIntervalRef.current = setInterval(() => {
      if (workStartTimeRef.current) {
        const elapsed = Math.floor((Date.now() - workStartTimeRef.current) / 1000);
        setElapsedTime(elapsed);
      }
    }, 1000);
  } else if (!isExploring && workStartTimeRef.current) {
    // Finalize time and stop interval
    const finalElapsed = Math.floor((Date.now() - workStartTimeRef.current) / 1000);
    setElapsedTime(finalElapsed);
    
    clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = null;
    workStartTimeRef.current = null;
  }

  return () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
    }
  };
}, [isExploring]);
```

**What controls `isExploring`:**
- `message.isStreaming` from backend streaming state
- Tool calls with `status === "calling"`
- Set by `useAgent.ts` based on WebSocket chunks

### Files Changed

**Backend (reverted server-side timing):**
- `src/gateway/websocket/agent.ts` - Removed `elapsedSeconds` from chunks

**Frontend (client-side timer):**
- `ui/components/Chat/WorkingCard.tsx` - Timestamp-based timer implementation
- `ui/components/Chat/MessageItem.tsx` - Removed `elapsedSeconds` prop
- `ui/hooks/useAgent.ts` - Removed elapsed time tracking from chunks
- `ui/types/chat.ts` - Removed `elapsedSeconds` from ChatMessage interface

### Testing Checklist

- [x] Timer updates smoothly every 1 second when on active tab
- [x] Timer continues counting when switching to different tab
- [x] Returning to tab shows correct elapsed time (no reset)
- [x] Timer stops when work completes (`isExploring` false)
- [x] Multiple chats have independent timers
- [x] Timer resets for new work sessions in same chat

### Performance

- **Memory**: Negligible (one interval per active working card)
- **CPU**: Minimal (simple math operation every 1 second)
- **Network**: Zero overhead (no WebSocket traffic for timer)
- **Battery**: Standard `setInterval` overhead (acceptable)

## Alternative Approaches Considered

**❌ Server-side with heartbeat chunks:**
- Send elapsed time with every chunk
- Problem: Only updates when chunks arrive (stuttering)

**❌ Server-side with 1-second heartbeat:**
- Send time chunk every 1 second
- Problem: Unnecessary WebSocket traffic, wasteful

**❌ Client-side with accumulated time:**
- Track time only when interval fires, handle gaps
- Problem: Complex gap detection, still has throttling issues

**✅ Client-side with timestamp (chosen):**
- Simple, accurate, no backend overhead
- Works perfectly across tab switches via timestamp math

## Related Issues

- Original issue: Timer only advanced when chunks arrived
- Tab switching: Browser throttles intervals when tab not visible
- Computer sleep: Should stop timer (via `isExploring` false from disconnect)

## Future Enhancements

1. **Pause indicator**: Show "(paused)" when computer sleeps
2. **Precision**: Option for millisecond precision for debugging
3. **Stats**: Track total work time across all chats (analytics)
