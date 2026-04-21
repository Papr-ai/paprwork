# EventEmitter Memory Leak Fix

**Date:** 2026-04-17  
**Issue:** MaxListenersExceededWarning in Gateway process  
**Root Cause:** Concurrent IPC requests in CustomKeysService  

## Problem

The error logs showed:
```
(node:27450) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 
11 message listeners added to [process]. MaxListeners is 10. 
Use emitter.setMaxListeners() to increase limit
```

### What Was Happening

`CustomKeysService` methods (`listKeys()`, `getKeyByName()`) each add a temporary `process.on('message')` listener to wait for IPC responses from the main process:

```typescript
async listKeys(): Promise<CustomKey[]> {
  return new Promise((resolve, reject) => {
    const messageHandler = (message: any) => {
      // Handle response
    };
    
    process.on("message", messageHandler); // ← Listener added
    
    // Send request via IPC
    this.safeSend({ type: "CUSTOM_KEYS_LIST", requestId });
  });
}
```

When multiple operations need custom keys **concurrently** (e.g., 10 jobs checking for API keys simultaneously), all 10+ listeners are added at once, exceeding Node's default limit of 10 listeners per EventEmitter.

**Why This Happens:**
- Job scheduling triggers multiple jobs
- Each job executor checks for custom keys
- All checks happen in parallel
- Each check adds a temporary listener
- Listeners accumulate faster than they're cleaned up
- Node warns when > 10 listeners on one emitter

## Solution

### Increased Max Listeners

Added explicit limit increase in Gateway startup:

```typescript
// Start the gateway
startGateway();

// Increase max listeners for process IPC (CustomKeysService uses many concurrent requests)
process.setMaxListeners(20);
```

**Why 20?**
- Current peak: 11 listeners
- Growth buffer: 9 additional slots
- Still detects real leaks (if it exceeds 20, something is wrong)

### Why This Is Safe

1. **Listeners are temporary** - Each is removed after response:
   ```typescript
   const cleanup = () => {
     clearTimeout(timeout);
     process.off("message", messageHandler); // ← Removed
   };
   ```

2. **Bounded by concurrent operations** - Max listeners = max concurrent jobs
3. **Legitimate use case** - Multiple requests in flight is expected behavior
4. **Still protected** - Warning appears if we exceed 20 (indicates real leak)

## Alternative Solutions Considered

### ❌ Serialize IPC Requests

Could queue all custom key requests through a single listener:

```typescript
class IPCQueue {
  private queue: Array<{ requestId: string; resolve: Function }> = [];
  
  constructor() {
    // Single listener for all requests
    process.on('message', this.handleMessage.bind(this));
  }
  
  async request(type: string, data: any): Promise<any> {
    const requestId = generateId();
    return new Promise((resolve) => {
      this.queue.push({ requestId, resolve });
      this.safeSend({ type, requestId, ...data });
    });
  }
}
```

**Why we didn't do this:**
- More complex (queue management, error handling)
- Performance impact (serializes concurrent requests)
- Overkill for this use case (cleanup already works)

### ❌ Reduce Concurrent Jobs

Could limit how many jobs run simultaneously:

```typescript
const MAX_CONCURRENT_JOBS = 5;
```

**Why we didn't do this:**
- Artificial limitation (users want multiple jobs)
- Doesn't solve root issue (still hits limit with 5+ concurrent operations)

### ✅ Increase Limit (Chosen)

Simplest solution that acknowledges the legitimate use case.

## Testing

Verified fix handles concurrent operations:
```bash
# Run 15+ jobs simultaneously
npm run test:jobs-e2e
npm run test:jobs-advanced

# No warnings in console
# All jobs complete successfully
```

## Monitoring

Watch for warnings in production:
```bash
# If this appears again, investigate
MaxListenersExceededWarning: ... 21 message listeners

# Indicates real leak (listeners not being cleaned up)
```

## Related Issues

- Issue 54: Ollama Event Listener Memory Leak (similar pattern, different fix)
- Enhancement 19: Job Scheduler Improvements (added concurrent execution)

## Pattern for Other Services

When you have concurrent IPC operations:

1. **Calculate realistic max** - Count peak concurrent operations
2. **Set explicit limit** - `emitter.setMaxListeners(peak + buffer)`
3. **Document why** - Explain legitimate use case
4. **Monitor** - Watch for exceeding new limit (real leak indicator)

Example:
```typescript
// Service with concurrent IPC
class MyService {
  constructor() {
    // Peak: 10 concurrent operations
    // Buffer: 10 additional slots
    process.setMaxListeners(20);
  }
}
```

## Performance Impact

None - only changes warning threshold, doesn't affect execution.

## Prevention

Before adding IPC listeners:
1. Estimate peak concurrent operations
2. Set max listeners accordingly
3. Ensure cleanup happens (use `finally` blocks)
4. Monitor for warnings (real leak detection)
