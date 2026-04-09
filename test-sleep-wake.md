# Testing Sleep/Wake Handling

## Quick Test Steps

### 1. Start the App
```bash
npm start
```

### 2. Test Connection Indicator
The indicator should be in the **bottom-left sidebar**, to the left of Settings button.

**When connected (normal):**
- Indicator is **hidden** (clean UI)

**To test disconnection:**
- Stop the Gateway manually:
  ```bash
  npm run kill:gateway
  ```
- You should see a **yellow badge** with pulsing dot: "Reconnecting..."
- After 30 seconds, it becomes **red**: "Disconnected"

**To test reconnection:**
- Restart Gateway (or just restart the app)
- Indicator should disappear after connection is established

### 3. Test Sleep/Wake (macOS)

**Prepare:**
1. Create a scheduled job (every 1 minute for easy testing):
   ```
   Ask agent: "Create a test job that prints the current time every minute"
   ```
2. Watch the job run once to confirm it works

**Test sleep:**
1. Put Mac to sleep (⌘ + Option + Power, or close laptop lid)
2. Wait 2-3 minutes
3. Wake the computer

**Expected behavior (check terminal logs):**
```
[Electron] System resumed (wake)
[Gateway] System resumed - reconciling state
[Gateway] State reconciliation complete after system resume
[JobsScheduler] Tick started
[JobsScheduler] Launching job xxx for missed slot
```

**Expected UI:**
- Brief "Reconnecting..." indicator appears (1-5 seconds)
- Indicator disappears when connected
- Check Jobs view - missed job should have run

### 4. Test WebSocket Reconnection with Backoff

**Terminal output to watch for:**
```
[Gateway] Reconnecting in 543ms (attempt 1/30, base: 500ms, jitter: 0.87)
[Gateway] Reconnecting in 1847ms (attempt 2/30, base: 1000ms, jitter: 0.92)
[Gateway] Reconnecting in 3124ms (attempt 3/30, base: 2000ms, jitter: 0.78)
```

Notice:
- Delays increase exponentially (500ms → 1s → 2s → 4s...)
- Jitter varies (0.5-1.0x multiplier)
- Attempts limited to 30

### 5. Test Heartbeat

With Gateway running, watch for ping/pong:
```bash
# In browser console (DevTools)
# Should see periodic activity every 15 seconds (in Network tab, WS filter)
```

## Console Commands for Testing

```javascript
// Check connection state
window.__gateway = (await import('./src/lib/gateway.js')).gateway;
console.log('Connected:', window.__gateway.isConnected());
console.log('State:', window.__gateway.getConnectionState());

// Manually disconnect (for testing indicator)
window.__gateway.ws.close();
```

## What to Look For

✅ **Success indicators:**
- No duplicate job runs after wake
- Jobs reconcile within 5-15 seconds
- UI shows reconnection status clearly
- No console errors
- Exponential backoff with jitter working

❌ **Failure indicators:**
- Jobs don't run after wake
- WebSocket doesn't reconnect
- Multiple rapid reconnection attempts (no backoff)
- Indicator stuck in "Reconnecting..." state

## Troubleshooting

**Gateway not starting:**
```bash
npm run kill:gateway
npm start
```

**WebSocket won't reconnect:**
- Check if Gateway is actually running: `curl http://localhost:18789/health`
- Check browser console for errors
- Try reloading page (Cmd+R)

**Jobs not reconciling:**
- Check Gateway logs for "State reconciliation" message
- Check job status in Jobs view
- Verify job schedule is actually enabled

## Cross-Platform Testing

**macOS:** Use sleep test above
**Windows:** Use "Sleep" from Start menu power options
**Linux:** Use `systemctl suspend` or close laptop lid

**Note:** Windows 11 24H2 has a known bug where suspend handlers may not execute reliably. If this affects you, the app will still recover via heartbeat timeout + exponential backoff.
