# System Sleep/Wake Handling

**Added:** 2026-03-31

Paprwork V2 now handles system sleep/wake events across macOS, Windows, and Linux to ensure jobs continue running and WebSocket connections recover properly after computer wakes from sleep.

---

## Problem Statement

When a computer goes to sleep:
- **Gateway Process:** Node.js process is suspended by the OS, all timers pause
- **WebSocket Connections:** Become stale/disconnected
- **Scheduled Jobs:** Miss their scheduled run times
- **Active Agent Streams:** Stop mid-response (streaming lost)

**Before this fix:**
- Users had to manually restart jobs after wake
- WebSocket required page refresh to reconnect
- Agent responses were lost if sleep occurred mid-stream

**After this fix:**
- Jobs automatically reconcile and run missed schedules
- WebSocket auto-reconnects with exponential backoff + jitter
- UI shows clear connection state (reconnecting/disconnected)
- No manual intervention required

---

## Architecture

### 1. Electron Main Process (Power Monitoring)

Uses Electron's `powerMonitor` API to detect system power state changes.

**Supported Platforms:** macOS, Windows, Linux

**Events:**
- `suspend` - System going to sleep
- `resume` - System waking from sleep
- `lock-screen` - Screen locked (macOS, Windows only)
- `unlock-screen` - Screen unlocked (macOS, Windows only)

**Implementation:** `src/electron/index.cjs`

```javascript
const { powerMonitor } = require("electron");

powerMonitor.on('suspend', () => {
  // Notify Gateway via IPC
  gatewayProcess.send({ type: 'SYSTEM_SUSPEND', timestamp: Date.now() });
  
  // Notify UI via IPC → DOM event
  mainWindow.webContents.send('system:suspend', { timestamp: Date.now() });
});

powerMonitor.on('resume', () => {
  // Notify Gateway via IPC
  gatewayProcess.send({ type: 'SYSTEM_RESUME', timestamp: Date.now() });
  
  // Notify UI via IPC → DOM event
  mainWindow.webContents.send('system:resume', { timestamp: Date.now() });
});
```

### 2. Gateway Process (Job Reconciliation)

Handles IPC messages from main process and reconciles job state.

**Implementation:** `src/gateway/index.ts`

```typescript
process.on("message", async (message) => {
  if (message.type === "SYSTEM_RESUME") {
    console.log("[Gateway] System resumed - reconciling state");
    
    // Reconcile jobs that may have been missed during sleep
    const jobsService = getJobsService();
    await jobsService.reconcileStaleRunningJobs();
    
    // Force scheduler to re-evaluate all jobs immediately
    const scheduler = getJobsScheduler();
    await scheduler.tickNow();
  }
});
```

**What happens:**
1. Jobs marked as "running" but with no active process are marked as failed
2. Scheduler immediately checks all jobs to see if any are due
3. Missed job runs are executed according to misfire policy (run now vs skip)

### 3. UI (WebSocket Auto-Reconnection)

**Exponential Backoff with Jitter:**
- Prevents "thundering herd" problem (all clients reconnecting at once)
- Starts at 500ms, doubles each attempt: 500ms → 1s → 2s → 4s → 8s → 16s → 30s (capped)
- Jitter: multiply by random factor (0.5-1.0) to spread reconnection attempts

**Implementation:** `ui/src/lib/gateway.ts`

```typescript
private attemptReconnect(): void {
  this.reconnectAttempts++;
  
  // Exponential backoff
  const exponentialDelay = Math.min(
    this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
    this.maxReconnectDelay
  );
  
  // Add jitter (0.5-1.0x)
  const jitter = 0.5 + Math.random() * 0.5;
  const delay = Math.floor(exponentialDelay * jitter);
  
  setTimeout(() => this.connect(), delay);
}
```

**Heartbeat Mechanism:**
- Sends `ping` every 15 seconds
- Expects `pong` response within 5 seconds
- Reconnects if 3 consecutive heartbeats missed

**System Resume Integration:**
- Listens for `system:resume` DOM event
- Resets backoff counter (connect immediately, not after 30s)
- Ensures quick reconnection after wake

### 4. Connection State Indicator

Shows visual feedback to users when connection is lost.

**States:**
- `connected` - Hidden (clean UI)
- `reconnecting` - Yellow badge with pulsing dot + "Reconnecting..."
- `disconnected` - Red badge + "Disconnected"

**Implementation:** `ui/components/ConnectionIndicator/ConnectionIndicator.tsx`

```typescript
export function ConnectionIndicator() {
  const [connectionState, setConnectionState] = useState(gateway.getConnectionState());
  
  useEffect(() => {
    const unsubscribe = gateway.onConnectionChange(() => {
      setConnectionState(gateway.getConnectionState());
    });
    return unsubscribe;
  }, []);
  
  // Don't show when connected (clean UI)
  if (connectionState === "connected") return null;
  
  return (
    <div className={`connection-indicator connection-indicator--${connectionState}`}>
      <div className="connection-indicator__dot" />
      <span>{connectionState === "reconnecting" ? "Reconnecting..." : "Disconnected"}</span>
    </div>
  );
}
```

---

## User Experience

### Before Sleep
- No visible changes
- All functionality works normally

### During Sleep
- All processes suspended by OS
- WebSocket connection becomes stale
- Timers paused

### After Wake

**Automatic Recovery (5-15 seconds):**

1. **Electron detects resume** (immediate)
   - Sends IPC messages to Gateway and UI

2. **Gateway reconciles jobs** (~1-2 seconds)
   - Marks stale "running" jobs as failed
   - Checks all scheduled jobs
   - Runs missed jobs according to misfire policy

3. **WebSocket reconnects** (~1-5 seconds with jitter)
   - UI shows "Reconnecting..." indicator
   - Exponential backoff prevents server overload
   - System resume event resets backoff for fast reconnection

4. **UI updates** (immediate after reconnect)
   - Indicator disappears
   - Agent can receive messages again
   - Jobs visible in UI with updated status

**User sees:**
- Brief "Reconnecting..." indicator in top-right
- Jobs continue running after wake
- No data loss for completed work during sleep

**User doesn't need to:**
- Refresh the page
- Manually restart jobs
- Re-send lost messages

---

## Technical Details

### Platform Differences

| Feature | macOS | Windows | Linux |
|---------|-------|---------|-------|
| `suspend` event | ✅ Yes | ✅ Yes | ✅ Yes |
| `resume` event | ✅ Yes | ✅ Yes | ✅ Yes |
| `lock-screen` | ✅ Yes | ✅ Yes | ❌ No |
| `unlock-screen` | ✅ Yes | ✅ Yes | ❌ No |

**Known Issues:**
- Windows 11 24H2: `suspend` event fires but handler may not execute reliably (Microsoft bug, not Electron)
- Linux production mode: Some users report events only fire in development (unconfirmed)

### Reconnection Strategy

Based on best practices from WebSocket.org and real-world Electron apps:

**Key Principles:**
1. **Exponential Backoff** - Prevents rapid retry loops (500ms → 30s)
2. **Jitter** - Spreads reconnection attempts (prevents thundering herd)
3. **Heartbeat** - Detects dead connections before OS timeout (15s ping/pong)
4. **State Synchronization** - Gateway reconciles missed work on reconnect
5. **Visual Feedback** - Users know what's happening (connection indicator)

**Why This Approach:**
- ✅ Prevents server overload when many clients wake simultaneously
- ✅ Detects dead connections faster than TCP timeout (can take minutes)
- ✅ Recovers gracefully from network switches (WiFi → Ethernet)
- ✅ Works with load balancers and proxies
- ✅ Industry standard (used by Slack, Discord, VS Code, etc.)

### Edge Cases Handled

1. **Long Sleep (>30 minutes)**
   - Reconnection backoff caps at 30s (not hours)
   - System resume event resets backoff → immediate reconnect
   - Scheduler reconciles ALL missed jobs, not just recent ones

2. **Network Switch During Sleep**
   - WebSocket onclose → triggers reconnection
   - Heartbeat timeout → triggers reconnection
   - System resume → resets backoff for fast recovery

3. **Rapid Sleep/Wake Cycles**
   - Each resume event resets backoff counter
   - No penalty for frequent sleep/wake
   - Gateway tolerates duplicate reconciliation calls

4. **Active Agent Stream During Sleep**
   - Streaming lost (WebSocket buffer cleared by OS)
   - UI shows error or reconnection indicator
   - User can retry message after reconnect
   - **Future:** Save streaming state for resume

---

## Files Changed

**Electron Main Process:**
- `src/electron/index.cjs` - Added powerMonitor handlers
- `src/electron/preload.cjs` - Forward system events to DOM

**Gateway Process:**
- `src/gateway/index.ts` - IPC message handler for SYSTEM_RESUME
- `src/gateway/websocket/index.ts` - Ping/pong heartbeat handler

**UI:**
- `ui/src/lib/gateway.ts` - Exponential backoff + jitter, heartbeat, system resume listener
- `ui/components/ConnectionIndicator/ConnectionIndicator.tsx` - Connection state indicator
- `ui/components/ConnectionIndicator/ConnectionIndicator.css` - Indicator styling
- `ui/App.tsx` - Added ConnectionIndicator to layout

**Documentation:**
- `docs/SYSTEM_SLEEP_WAKE_HANDLING.md` - This file

---

## Testing Checklist

### macOS
- [x] System sleep → wake → jobs reconcile
- [x] System sleep → wake → WebSocket reconnects
- [x] Screen lock → unlock → no issues
- [ ] Long sleep (1+ hour) → fast reconnection
- [ ] Active agent stream during sleep → proper error handling

### Windows
- [ ] System sleep → wake → jobs reconcile
- [ ] System sleep → wake → WebSocket reconnects
- [ ] Screen lock → unlock → no issues
- [ ] Windows 11 24H2 → verify workaround if needed

### Linux
- [ ] System sleep → wake → jobs reconcile
- [ ] System sleep → wake → WebSocket reconnects
- [ ] Production build → events fire correctly

### General
- [ ] Multiple rapid sleep/wake cycles
- [ ] Network switch (WiFi → Ethernet) during operation
- [ ] 10+ clients wake simultaneously (no thundering herd)
- [ ] Gateway crash → UI reconnects after restart
- [ ] Scheduled job missed during sleep → runs on wake

---

## Future Enhancements

1. **Agent Stream Recovery**
   - Save streaming state before suspend
   - Show "Resume" button after reconnect
   - Continue from last received chunk

2. **Smart Misfire Policy**
   - User-configurable: run missed jobs vs skip
   - Priority-based: critical jobs run first
   - Rate limiting: don't overwhelm system on wake

3. **Connection Quality Indicator**
   - Show latency/packet loss
   - Warn before connection becomes unstable
   - Suggest troubleshooting steps

4. **Offline Mode**
   - Queue messages while disconnected
   - Replay after reconnection
   - Conflict resolution for concurrent edits

5. **Battery Awareness**
   - Pause non-critical jobs on low battery
   - Resume automatically when plugged in
   - Adjust reconnection aggressiveness based on battery

---

## References

- [Electron powerMonitor API](https://www.electronjs.org/docs/latest/api/power-monitor)
- [WebSocket Reconnection Best Practices](https://www.websocket.org/guides/reconnection/)
- [Exponential Backoff with Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- [GitHub Issue: Electron powerMonitor Linux support](https://github.com/electron/electron/pull/27958)

---

**Status:** ✅ Implemented, awaiting cross-platform testing
**Testing Required:** Windows 11, Ubuntu 22.04+
**Known Limitations:** Active agent streams not resumable (future enhancement)
