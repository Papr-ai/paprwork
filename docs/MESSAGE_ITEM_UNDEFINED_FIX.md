# MessageItem `message is not defined` Fix

**Date:** 2026-02-17  
**Issue:** Production build shows blank screen with `ReferenceError: message is not defined`  
**Status:** ✅ Fixed

---

## Problem

When running `npm start` (production mode), the app window opened but showed a blank screen. The browser console showed:

```
ReferenceError: message is not defined
    at cn (index-D655ehNq.js:41:5136)
    at mn (index-D655ehNq.js:43:3542)
    at is (editor-Csfrs-Ew.js:90:381)
```

The error occurred in the `MessageItem` component when rendering messages with sequences (V1-style interleaved text and tool calls).

**Key observation:** `npm run dev` worked fine, only production build failed.

---

## Root Cause

In `ui/components/Chat/MessageItem.tsx`, the `renderSequence()` function referenced the `message` variable without receiving it as a parameter:

```typescript
// ❌ BEFORE - message not in scope
function renderSequence(
  sequence: Array<{ type: string; data: any }>,
  isStreaming?: boolean
): React.ReactNode {
  // ...
  const reasoning = message.isStreaming  // ❌ message is not defined!
    ? message.streamingReasoning || message.reasoning
    : message.reasoning;
  // ...
  isStreaming={message.isStreaming}  // ❌ message is not defined!
}
```

The function signature only included `sequence` and `isStreaming`, but the function body accessed `message.isStreaming`, `message.streamingReasoning`, and `message.reasoning` directly.

**Why dev mode worked:**
- Development builds with Vite may have looser variable scoping
- Hot Module Replacement (HMR) may preserve parent scope
- Production builds are minified and have stricter scoping

---

## Solution

Pass the full `message` object to `renderSequence()` instead of just `isStreaming`:

```typescript
// ✅ AFTER - message properly passed
function renderSequence(
  sequence: Array<{ type: string; data: any }>,
  message: ChatMessage  // ✅ Now has access to message
): React.ReactNode {
  // ...
  const reasoning = message.isStreaming  // ✅ Works!
    ? message.streamingReasoning || message.reasoning
    : message.reasoning;
  // ...
  isStreaming={message.isStreaming}  // ✅ Works!
}
```

Update the call site:

```typescript
// ❌ BEFORE
renderSequence(message.sequence!, message.isStreaming)

// ✅ AFTER
renderSequence(message.sequence!, message)
```

---

## Files Changed

1. **`ui/components/Chat/MessageItem.tsx`**:
   - Changed `renderSequence` signature: `(sequence, isStreaming?)` → `(sequence, message)`
   - Updated call site: `renderSequence(message.sequence!, message.isStreaming)` → `renderSequence(message.sequence!, message)`

---

## Testing Steps

1. **Rebuild UI:**
   ```bash
   npm run build:ui
   ```

2. **Rebuild native modules (if needed):**
   ```bash
   npx @electron/rebuild
   ```

3. **Start production mode:**
   ```bash
   npm start
   ```

4. **Verify:**
   - Window opens ✓
   - UI loads ✓
   - Messages render ✓
   - Sequences with tools render ✓
   - Thinking cards display ✓

---

## Related Issues

- **Better-sqlite3 version mismatch:** Required `npx @electron/rebuild` after Node v24 upgrade
- **DevTools in production:** Temporarily enabled DevTools to debug (reverted after fix)

---

## Prevention

**Lessons learned:**

1. **Always test production builds** (`npm start`) before releasing, not just dev mode
2. **Function parameters must be explicit** - don't rely on parent scope in nested functions
3. **TypeScript should catch this** - consider enabling stricter checks for unused variables
4. **Add linting rules** for accessing variables not in function scope

**Recommended linting rule:**
```json
{
  "rules": {
    "no-undef": "error"
  }
}
```

---

## See Also

- `TEXT_BUFFER_FLUSH_FIX.md` - Previous streaming text issue
- `THINKING_CARD_DISPLAY_FIX.md` - Related UI rendering fix
- `CLAUDE.md` - Issue #6: Native Module Version Mismatch
