# Error Handling Fix: User-Friendly API Error Messages

**Date:** 2026-02-20

## Problem

When API errors occurred (e.g., "Your credit balance is too low to access the Anthropic API"), they were being displayed as `[object Object]` in the notification banner instead of showing the actual error message.

## Root Cause

The error object from the AI SDK was not being properly converted to a string. The error could be in various formats:

1. Plain object: `{ message: "..." }`
2. Nested error: `{ error: { message: "..." } }`
3. Deep nested: `{ data: { error: { message: "..." } } }`
4. Already a string

When JavaScript tries to convert an object to a string using `String(obj)`, it results in `[object Object]`.

## Solution

### 1. Backend: Extract Error Messages (`streamOrchestrator.ts`)

Added `extractErrorMessage()` function that:
- Checks if error is already a string → return it
- Checks if error is an Error object → return `error.message`
- Checks common API error patterns:
  - `{ message: "..." }`
  - `{ error: { message: "..." } }`
  - `{ data: { error: { message: "..." } } }`
- Falls back to `JSON.stringify()` if structure is unknown
- Returns "Unknown error" as last resort

```typescript
function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  
  if (typeof error === "object" && error !== null) {
    const errorObj = error as Record<string, unknown>;
    
    // Pattern 1: { message: "..." }
    if (typeof errorObj.message === "string") {
      return errorObj.message;
    }
    
    // Pattern 2: { error: { message: "..." } }
    if (typeof errorObj.error === "object" && errorObj.error !== null) {
      const nested = errorObj.error as Record<string, unknown>;
      if (typeof nested.message === "string") {
        return nested.message;
      }
    }
    
    // ... more patterns
  }
  
  return "Unknown error";
}
```

### 2. Frontend: Provider-Specific Error Messages (`useAgent.ts`)

Enhanced error handling in the `case "error"` branch to provide user-friendly messages:

```typescript
case "error": {
  const payload = chunk.payload as { error: string };
  const rawError = payload.error || "Unknown error";
  
  let errorMsg = rawError;
  
  // Pattern: "Your credit balance is too low to access the X API"
  if (rawError.includes("credit balance is too low")) {
    const providerMatch = rawError.match(/access the (\w+) API/);
    const provider = providerMatch ? providerMatch[1] : "provider";
    errorMsg = `Credit balance too low for ${provider}. Please add credits or switch to a different model.`;
  }
  // Pattern: Rate limit errors
  else if (rawError.includes("rate limit") || rawError.includes("429")) {
    errorMsg = `Rate limit exceeded. Please try again in a moment.`;
  }
  // Pattern: API key errors
  else if (rawError.includes("API key")) {
    errorMsg = `API key error: ${rawError}`;
  }
  
  setError(errorMsg);
  // ... cleanup
}
```

## Error Flow

1. **API Error** → AI SDK throws `APICallError`
2. **AgentService** → Catches error, creates error chunk
3. **streamOrchestrator** → `extractErrorMessage()` converts to string
4. **WebSocket** → Sends error chunk to frontend
5. **useAgent** → Enhances message with provider-specific text
6. **ChatContainer** → Displays in error banner

## Testing

### Before Fix
```
Error banner shows: [object Object]
```

### After Fix
```
Error banner shows: Credit balance too low for Anthropic. Please add credits or switch to a different model.
```

## Files Changed

1. `src/gateway/services/agent/streamOrchestrator.ts`
   - Added `extractErrorMessage()` function
   - Updated `case "error"` to use new function

2. `ui/hooks/useAgent.ts`
   - Enhanced error message handling
   - Added provider-specific error patterns

## Edge Cases Handled

✅ Error is already a string  
✅ Error is an Error object  
✅ Error is `{ message: "..." }`  
✅ Error is `{ error: { message: "..." } }`  
✅ Error is `{ data: { error: { message: "..." } } }`  
✅ Error is unserializable  
✅ Credit balance errors → Provider-specific message  
✅ Rate limit errors → Friendly message  
✅ API key errors → Descriptive message  

## Future Improvements

1. **Error Categories**: Create enum for error types (credit, rate limit, auth, etc.)
2. **Actionable Errors**: Add "Fix" buttons for common errors (e.g., "Add Credits" button)
3. **Error Telemetry**: Track which errors occur most frequently
4. **Retry Logic**: Automatically retry on transient errors (rate limits)
5. **Multi-language**: Support localized error messages

## Related Issues

- User reported `[object Object]` notification on 2026-02-20
- Similar to Issue #X (if tracked in issue tracker)

## Testing Checklist

- [x] Credit low error shows provider name
- [ ] Rate limit error shows friendly message
- [ ] API key error is descriptive
- [ ] Unknown errors don't crash UI
- [ ] Error banner displays correctly
- [ ] Error clears after successful message
