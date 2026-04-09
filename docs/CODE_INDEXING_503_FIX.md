# Code Indexing 503 Error Fix

**Added:** 2026-04-01

## Problem

Code indexing was failing with 503 errors when trying to upload files to Papr Memory:

```
❌ Failed to index actions-swipe.js: 503 {"code":503,"status":"error","data":null,"error":"There was an error adding the memory item","details":null}
```

## Root Causes

### 1. **503 Not Detected as Rate Limit**
The error handler only checked for `403`, `limit`, or `quota` strings, not `503` or `429` status codes.

### 2. **Duplicate Initialization**
Two callers were simultaneously starting code indexing:
- `keyResolver.ts` (when PAPR_API_KEY first loaded)
- `gateway/index.ts` (3-second startup timeout)

This created **two separate indexers** trying to upload the same files, doubling the API load.

### 3. **Aggressive Batch Processing**
- **Batch size:** 50 files processed at once
- **No delay:** Files uploaded back-to-back without pausing
- **Result:** 50+ API calls in <5 seconds → rate limiting

## Solutions Applied

### 1. Enhanced Error Detection

**File:** `src/gateway/services/storage/SmartCodeIndexManager.ts`

```typescript
// Before: Only checked 403, "limit", "quota"
const isRateLimitError = error instanceof Papr.RateLimitError || 
                          error instanceof Papr.PermissionDeniedError ||
                          err.message.includes('403') || 
                          err.message.includes('limit') ||
                          err.message.includes('quota');

// After: Added 503, 429
const isRateLimitError = error instanceof Papr.RateLimitError || 
                          error instanceof Papr.PermissionDeniedError ||
                          err.message.includes('403') || 
                          err.message.includes('503') || // Service unavailable (often rate limiting)
                          err.message.includes('429') || // Too many requests
                          err.message.includes('limit') ||
                          err.message.includes('quota');
```

### 2. Automatic Retry with Cooldown

**File:** `src/gateway/services/storage/SmartCodeIndexManager.ts`

```typescript
// Before: Paused forever on rate limit
if (hitRateLimit) {
  console.log('🛑 Indexing paused - PAPR Memory quota exceeded.');
  console.log('💡 Restart the app after upgrading to resume indexing.');
}

// After: Automatic 30-second retry
if (hitRateLimit) {
  console.log('⏸️  Indexing paused - PAPR Memory returned 503 errors.');
  console.log('💡 This may be temporary rate limiting - will retry in 30 seconds.');
  
  setTimeout(() => {
    console.log('🔄 Retrying indexing after 30-second cooldown...');
    this.rateLimitHit = false;
    this.triggerBatchIndex();
  }, 30000);
}
```

### 3. Reduced Batch Size

**File:** `src/gateway/services/CodeIndexingService.ts`

```typescript
// Before: 50 files per batch
indexManager = new SmartCodeIndexManager(client, {
  schemaId,
  debounceMs: 5000,
  batchSize: 50
});

// After: 10 files per batch
indexManager = new SmartCodeIndexManager(client, {
  schemaId,
  debounceMs: 5000,
  batchSize: 10 // Reduced to avoid rate limiting
});
```

### 4. Added Delay Between Files

**File:** `src/gateway/services/storage/SmartCodeIndexManager.ts`

```typescript
// After indexing each file successfully
console.log(`   ✅ Indexed: ${path.basename(queuedFile.file_path)}`);

// Add delay between files to avoid rate limiting (200ms)
await new Promise(resolve => setTimeout(resolve, 200));
```

**Impact:** 10 files now take ~2 seconds instead of <1 second (spreads load).

### 5. Fixed Duplicate Initialization

**File:** `src/gateway/services/CodeIndexingService.ts`

Added initialization mutex to prevent race condition:

```typescript
let initializationPromise: Promise<void> | null = null; // Mutex

export async function ensureIndexingStarted(paprApiKey: string): Promise<void> {
  // If already initialized, return immediately
  if (indexingInitialized && indexManager) {
    return;
  }
  
  // If initialization is in progress, wait for it
  if (initializationPromise) {
    console.log('[CodeIndexing] Initialization already in progress, waiting...');
    return initializationPromise;
  }
  
  // Start initialization and store the promise
  initializationPromise = (async () => {
    try {
      await initializeCodeIndexing(paprApiKey);
      indexingInitialized = true;
    } finally {
      initializationPromise = null; // Clear mutex
    }
  })();
  
  return initializationPromise;
}
```

**Result:** Logs now show:
```
[KeyResolver] PAPR_API_KEY resolved, triggering code indexing...
[CodeIndexing] Starting lazy initialization...
[Gateway] PAPR_API_KEY found, starting code indexing...
[CodeIndexing] Initialization already in progress, waiting... ✅
```

### 6. Enhanced Error Details

**File:** `src/gateway/services/storage/CodeIndexerService.ts`

```typescript
await this.client.memory.add({ ... }).catch((error) => {
  const err = error as any;
  throw new Error(
    `${err.statusCode || err.code || 'Unknown'} ${JSON.stringify(err.body || err.message || err)}`
  );
});
```

Now errors include full API response for better debugging.

## Impact

| Metric | Before | After |
|--------|--------|-------|
| Batch size | 50 files | **10 files** ✅ |
| Files/second | ~50/s | **~5/s** ✅ |
| Duplicate indexers | ❌ 2 running | ✅ 1 running |
| 503 detection | ❌ Not detected | ✅ Detected |
| Retry behavior | ❌ Stop forever | ✅ Auto-retry 30s |
| Delay between files | 0ms | **200ms** ✅ |

## What the 503 Error Means

**HTTP 503 Service Unavailable** can indicate:

1. **Temporary Rate Limiting**
   - Too many requests in short time
   - Retry after cooldown usually works
   
2. **Service Downtime**
   - Backend issue on Papr platform
   - Check https://dashboard.papr.ai status
   
3. **Quota Exceeded**
   - Free tier limits reached
   - Upgrade at https://platform.papr.ai/settings

## Testing

### Verify Fixes

1. **Single Initialization:**
```bash
# Start app, check logs
npm start

# Should see:
# [CodeIndexing] Starting lazy initialization...
# [CodeIndexing] Initialization already in progress, waiting... ✅
```

2. **Retry Logic:**
```bash
# Watch logs for 503 errors
tail -f ~/.cursor/projects/.../terminals/213085.txt | grep -A 5 "503"

# Should see after 30 seconds:
# 🔄 Retrying indexing after 30-second cooldown...
```

3. **Reduced Load:**
```bash
# Check batch size in logs
grep "Processing batch" ~/.cursor/projects/.../terminals/*.txt | tail -5

# Should see: "Processing batch: 10 files" (not 50)
```

### Monitor Queue

```bash
# Check how many files are queued
sqlite3 ~/.paprwork-v2/code-index.db "SELECT COUNT(*) FROM index_queue"

# Check queue details
sqlite3 ~/.paprwork-v2/code-index.db "SELECT file_path, priority FROM index_queue LIMIT 10"
```

## Next Steps

1. **If 503 Persists:**
   - Check Papr platform status
   - Contact support with account ID
   - Verify quota at https://platform.papr.ai/settings

2. **If Retry Works:**
   - Monitor logs for successful indexing
   - 30 queued files should clear gradually

3. **If Quota Exceeded:**
   - Upgrade plan at https://platform.papr.ai/settings
   - Indexing will resume automatically after upgrade

## Related

- Enhancement 30: Automatic Hybrid Code Search
- `src/gateway/services/storage/SmartCodeIndexManager.ts` - Batch processor
- `src/gateway/services/storage/CodeIndexerService.ts` - API caller
- `src/gateway/services/CodeIndexingService.ts` - Initialization
