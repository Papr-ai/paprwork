# Bash Tool Fix - Backgrounded Process Hanging Issue

## Problem

The bash tool had two critical issues that caused tool call failures:

1. **Backgrounded processes hang** - Commands like `nohup python main.py &` would cause the next 5-10 tool calls to return empty because Node's `exec` waited for stdio pipes to close, even though the process was backgrounded.

2. **Large output truncation** - Commands producing >10MB output were silently killed with SIGTERM due to `maxBuffer` limits, and stuck processes weren't properly terminated.

## Root Cause

The bash tool used `promisify(exec)` which has two failure modes:

- **maxBuffer limit**: 10MB limit - when stdout exceeds this, exec kills the child with SIGTERM
- **Stdio pipe blocking**: Backgrounded processes inherit the shell's stdio handles. Node's exec waits for ALL stdio pipes to close before resolving, so even though `nohup ... &` returned instantly, the tool stayed blocked on orphaned pipe references until the background process died or timeout fired (60s default).

## Solution

### 1. Detect Backgrounded Commands

Added `isBackgroundedCommand()` to detect commands ending with `&`, using `nohup`, or `disown`:

```typescript
function isBackgroundedCommand(command: string): boolean {
  const trimmed = command.trim();
  return /&\s*$/.test(trimmed) || /\bnohup\b/.test(trimmed) || /\bdisown\b/.test(trimmed);
}
```

### 2. Proper Detachment for Background Processes

Created `executeBackgroundedCommand()` that uses `spawn` with:
- `detached: true` - process runs independently
- `stdio: 'ignore'` - no stdio pipes inherited (prevents hanging)
- `unref()` - parent doesn't wait for child

```typescript
const proc = spawn(shellPath, shellArgs, {
  cwd: cwd || process.cwd(),
  env: Object.keys(env).length > 0 ? { ...process.env, ...env } : process.env,
  detached: true,
  stdio: 'ignore', // Critical: don't inherit stdio pipes
});
proc.unref();
```

Returns immediately with process PID and suggests using Job system for monitoring.

### 3. Increased Buffer Limit

Raised `maxBuffer` from 10MB to 100MB:

```typescript
maxBuffer: 100 * 1024 * 1024, // 100MB buffer (up from 10MB)
```

### 4. Explicit SIGKILL Timeout

Replaced SIGTERM with SIGKILL for stuck processes:

```typescript
const killTimer = setTimeout(() => {
  if (childProcess && !childProcess.killed) {
    console.warn('[Bash Tool] Timeout exceeded, sending SIGKILL');
    childProcess.kill('SIGKILL');
  }
}, timeout + 5000); // Give exec 5s grace period, then SIGKILL
```

### 5. Updated Streaming Function

Applied same fixes to `executeBashCommandStreaming()`:
- SIGKILL instead of SIGTERM on timeout
- Proper cleanup of kill timer on process close/error

## Impact

- **Fixes hanging tool calls** after backgrounded commands
- **Prevents silent output truncation** for high-volume commands
- **Ensures processes actually die** on timeout (SIGKILL vs SIGTERM)
- **Returns immediately** for backgrounded commands with PID info

## Testing Recommendations

1. Test backgrounded command: `nohup python -c "import time; time.sleep(100)" > /tmp/test.log 2>&1 &`
   - Should return immediately with PID
   - Next tool call should work instantly (not hang)

2. Test high-output command: `yes | head -n 1000000` (generates ~10MB+ output)
   - Should succeed with 100MB buffer
   - Previously would fail at 10MB

3. Test stuck process: `sleep 120` with 5s timeout
   - Should be killed via SIGKILL after timeout
   - Should return timeout error, not hang indefinitely

## Future Considerations

For long-running orchestration work (GCP deployments, test suites, training jobs), use the Job system instead of bash tool - Jobs handle their own stdio and are designed for long-running processes.
