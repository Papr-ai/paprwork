# PAPR Memory Quota Error Handling

**Status:** ✅ IMPLEMENTED  
**Date:** 2026-03-08  
**Author:** System

## Overview

Enhanced error handling for PAPR Memory API quota/rate limit errors across all integration points. When users hit their account quota, the system now provides clear upgrade instructions instead of generic error messages.

## Problem Statement

When users exceeded their PAPR Memory account quota, the system would show generic errors like:
- "🛑 Indexing paused due to rate limit. Restart app to retry."
- Generic 403 errors without context
- No guidance on how to resolve the issue

The actual issue is that free/basic tier accounts have usage quotas, and users need to upgrade their PAPR Memory account to continue using advanced features like code indexing and memory operations.

## Solution

### 1. Code Indexing (SmartCodeIndexManager)

**File:** `src/gateway/services/storage/SmartCodeIndexManager.ts`

**Changes:**
- Detect `RateLimitError` and `PermissionDeniedError` from PAPR SDK
- Show clear upgrade message when quota is exceeded:
  ```
  🛑 Indexing paused - PAPR Memory quota exceeded.
  💡 Please upgrade your account at: https://platform.papr.ai/settings
  💡 Restart the app after upgrading to resume indexing.
  ```

**Before:**
```typescript
if (isRateLimitError) {
  console.log('   ⚠️  Rate limit reached - stopping indexing.');
  hitRateLimit = true;
  break;
}
```

**After:**
```typescript
if (error instanceof Papr.RateLimitError || error instanceof Papr.PermissionDeniedError) {
  console.error(`   ❌ Failed to index ${queuedFile.file_path}: ${errorMessage}`);
  console.error('   💡 You need to upgrade your PAPR Memory account to continue indexing.');
  console.error('   💡 Visit https://platform.papr.ai/settings to upgrade.');
  hitRateLimit = true;
  break;
}
```

### 2. Message Storage (PaprMemoryProvider)

**File:** `src/gateway/services/storage/PaprMemoryProvider.ts`

**Changes:**
- Catch PAPR SDK error types explicitly
- Throw user-friendly error messages with upgrade link

**Before:**
```typescript
} else if (error instanceof Papr.RateLimitError) {
  console.error("PAPR rate limit exceeded, retrying...");
}
```

**After:**
```typescript
} else if (error instanceof Papr.RateLimitError) {
  console.error("PAPR Memory quota exceeded. Please upgrade your account.");
  throw new Error(
    "PAPR Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings"
  );
} else if (error instanceof Papr.PermissionDeniedError) {
  console.error("PAPR Memory access denied - quota may be exceeded.");
  throw new Error(
    "PAPR Memory access denied. Your account may have exceeded its quota. Please upgrade at https://platform.papr.ai/settings"
  );
}
```

### 3. PAPR Memory Tools (paprMemory.ts)

**File:** `src/core/tools/paprMemory.ts`

**Changes:**
- Added try-catch blocks to all 4 PAPR memory tools:
  - `add_agent_memory` - Store memory items
  - `search_agent_memory` - Search memories
  - `register_schema` - Register custom schemas
  - `list_schemas` - List available schemas

**Error handling pattern:**
```typescript
try {
  // Tool logic...
  return { success: true, data: response };
} catch (error) {
  if (error instanceof Papr.RateLimitError || error instanceof Papr.PermissionDeniedError) {
    throw new Error(
      "PAPR Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings to continue using memory features."
    );
  } else if (error instanceof Papr.AuthenticationError) {
    throw new Error(
      "Invalid PAPR API key. Please check your Settings and ensure your API key is correct."
    );
  }
  throw error;
}
```

### 4. SubAgent Memory Writeback (PaprMemoryWritebackService)

**File:** `src/gateway/services/PaprMemoryWritebackService.ts`

**Changes:**
- Added error handling to `writeRunMemory()` function
- Logs quota exceeded errors with job context
- Throws user-friendly error messages

```typescript
} catch (error) {
  if (error instanceof Papr.RateLimitError || error instanceof Papr.PermissionDeniedError) {
    console.error(`[PaprMemoryWritebackService] Memory quota exceeded for job ${input.jobId}`);
    console.error(`[PaprMemoryWritebackService] Please upgrade your PAPR Memory account at: https://platform.papr.ai/settings`);
    throw new Error(
      "PAPR Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings to continue using memory features."
    );
  }
  // ...
}
```

## PAPR SDK Error Types

The PAPR Memory SDK (`@papr/memory` v2.0.0) provides typed error classes:

```typescript
// From @papr/memory/core/error.d.ts
export class RateLimitError extends APIError<429, Headers> {}
export class PermissionDeniedError extends APIError<403, Headers> {}
export class AuthenticationError extends APIError<401, Headers> {}
```

Each error extends `APIError` which has:
- `status` - HTTP status code
- `headers` - Response headers
- `error` - JSON body from PAPR API (contains detailed error message)
- `message` - Error message string

## User Experience

### Before
User sees in terminal:
```
🛑 Indexing paused due to rate limit. Restart app to retry.
```

User doesn't know:
- What "rate limit" means
- How to fix it
- Where to go for help

### After
User sees in terminal:
```
🛑 Indexing paused - PAPR Memory quota exceeded.
💡 ${remaining} files remain in queue.
💡 Please upgrade your PAPR Memory account at: https://platform.papr.ai/settings
💡 Restart the app after upgrading to resume indexing.
```

User sees in chat (when using tools):
```
PAPR Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings to continue using memory features.
```

User now knows:
- ✅ The issue is their account quota
- ✅ They need to upgrade their PAPR account
- ✅ Exactly where to go (https://platform.papr.ai/settings)
- ✅ What to do after upgrading (restart app)

## Testing

### Manual Testing

1. **Code Indexing:**
   ```bash
   # With a free PAPR account that has exceeded quota:
   npm start
   # Watch terminal for indexing messages
   # Should see upgrade instructions instead of generic "rate limit" message
   ```

2. **Memory Tools:**
   ```bash
   # In chat, try to use PAPR memory:
   "Remember that my favorite color is blue"
   # Should see user-friendly quota error with upgrade link
   ```

3. **SubAgent Jobs:**
   ```bash
   # Create a job with memory writeback:
   "Create a job to analyze my codebase and save findings to memory"
   # Job should fail with clear quota error message
   ```

### Error Simulation

You can simulate quota errors by:
1. Using an invalid/expired API key (triggers `AuthenticationError`)
2. Using a free tier account and exceeding quota (triggers `RateLimitError`)
3. Making rapid API calls (may trigger `RateLimitError`)

## Impact

### Affected Components
- ✅ Code indexing (automatic background process)
- ✅ Manual memory operations (add/search tools)
- ✅ SubAgent job memory writeback
- ✅ Chat message persistence (when using PAPR storage)

### User Benefits
1. **Clarity** - Users understand the issue is quota-related
2. **Actionable** - Users know exactly where to upgrade
3. **Professional** - Error messages are polite and helpful
4. **Consistent** - Same upgrade message across all features

## Upgrade Flow

1. User hits quota limit
2. System shows upgrade message with link
3. User visits https://platform.papr.ai/settings
4. User upgrades PAPR Memory account
5. User restarts app (for code indexing) or retries operation (for tools)
6. System resumes normal operation

## Related Files

### Modified Files
- `src/gateway/services/storage/SmartCodeIndexManager.ts` - Code indexing
- `src/gateway/services/storage/PaprMemoryProvider.ts` - Message storage
- `src/core/tools/paprMemory.ts` - Memory tools (4 tools)
- `src/gateway/services/PaprMemoryWritebackService.ts` - SubAgent writeback

### Related Documentation
- `docs/CODE_INDEXING.md` - Code indexing architecture
- `docs/PAPR_MEMORY_METADATA_IMPLEMENTATION.md` - Memory metadata
- `docs/legacy-notes/PAPR_SDK_INTEGRATION_COMPLETE.md` - SDK integration

### PAPR SDK
- Package: `@papr/memory` v2.0.0
- Import: `import Papr from "@papr/memory";`
- Errors: `Papr.RateLimitError`, `Papr.PermissionDeniedError`, `Papr.AuthenticationError`

## Future Enhancements

### Potential Improvements
1. **UI Toast Notification** - Show upgrade prompt in app UI (not just console)
2. **Quota Status** - Display remaining quota in Settings
3. **Graceful Degradation** - Auto-disable PAPR features if quota exceeded (vs. showing errors)
4. **Retry Logic** - Auto-retry after user upgrades (detect quota increase)
5. **Usage Analytics** - Track quota usage to warn users before limit

### Not Implemented Yet
- No UI toast notification (only console logging)
- No quota status display in Settings
- No automatic retry after upgrade
- No usage tracking/warnings

## Notes

### Why PermissionDeniedError?
PAPR API returns 403 (Forbidden) when quota is exceeded, which maps to `PermissionDeniedError` in the SDK. We check for both `RateLimitError` (429) and `PermissionDeniedError` (403) to cover all quota scenarios.

### Why Not Automatic Retry?
We don't automatically retry because:
1. Quota limits are persistent (not temporary like network errors)
2. User needs to take action (upgrade account)
3. Retrying would waste API calls and hit quota faster
4. Better UX to show error once and wait for user action

### Message Consistency
All error messages follow the same pattern:
- State the problem ("PAPR Memory quota exceeded")
- Provide the solution ("Please upgrade your account")
- Include the exact link ("https://platform.papr.ai/settings")
- Add context-specific instructions (e.g., "Restart app" for indexing)

---

**Last Updated:** 2026-03-08  
**Status:** Production Ready ✅
