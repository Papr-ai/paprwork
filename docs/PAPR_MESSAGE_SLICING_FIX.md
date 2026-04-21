# PAPR Message Slicing Fix - Taking Newest Messages

**Date:** 2026-04-19
**Issue:** Messages were being cut off when PAPR summaries existed

## Problem

When PAPR returned a summary, the code was taking the **oldest 6 messages** instead of the **newest 6 messages**:

```typescript
// WRONG (before fix)
const recentMessages = summary 
  ? response.messages.slice(-6).reverse()  // Last 6 = OLDEST 6 ❌
  : response.messages.reverse();
```

### Why This Was Wrong

PAPR returns messages in **newest-first order** (reverse chronological):
```
[0] 2026-04-20T04:35:37  ← NEWEST
[1] 2026-04-20T04:34:29
[2] 2026-04-20T04:28:28
[3] 2026-04-20T04:28:21
[4] 2026-04-20T04:10:22
[5] 2026-04-20T04:09:59
[6] 2026-04-20T04:09:56
[7] 2026-04-20T04:08:59
[8] 2026-04-19T18:33:27  ← OLDEST
```

Using `.slice(-6)` took indexes `[3,4,5,6,7,8]` = the **oldest 6 messages**, cutting off the **newest 2 messages** `[0,1,2]`.

### Impact

**Example with 9 messages:**
- PAPR has: 9 messages (newest to oldest)
- Code took: Messages 3-8 (oldest 6)
- **Lost:** Messages 0-2 (newest 3) ❌
- User saw: Conversation missing the last 3 messages they sent/received

## Solution

Take the **first 6 messages** from PAPR's response (which are the newest):

```typescript
// CORRECT (after fix)
const recentMessages = summary 
  ? response.messages.slice(0, 6).reverse()  // First 6 = NEWEST 6 ✅
  : response.messages.reverse();
```

### How It Works Now

1. PAPR returns messages newest-first: `[0, 1, 2, 3, 4, 5, 6, 7, 8]`
2. `.slice(0, 6)` takes: `[0, 1, 2, 3, 4, 5]` (newest 6) ✅
3. `.reverse()` gives: `[5, 4, 3, 2, 1, 0]` (chronological order for LLM)

**Result:** LLM sees the 6 most recent messages in chronological order.

## Testing

**Before fix:**
```
[STAGE 1] Retrieved 9 messages from PAPR
[STAGE 1] Returning 6 recent messages (after filtering for summary)
[STAGE 1] After filtering - First: [2026-04-19T18:33:27] user  ← WRONG (oldest)
[STAGE 1] After filtering - Last: [2026-04-20T04:28:21] user   ← Missing 2 newer messages
```

**After fix:**
```
[STAGE 1] Retrieved 9 messages from PAPR
[STAGE 1] Returning 6 recent messages (after filtering for summary)
[STAGE 1] After filtering - First: [2026-04-20T04:10:22] assistant  ← CORRECT (6th newest)
[STAGE 1] After filtering - Last: [2026-04-20T04:35:37] assistant    ← CORRECT (newest)
```

## Why Only 6 Messages?

When PAPR provides a summary, the pattern is:
- **Summary** = Compressed context of all older messages
- **Recent messages** = Last 6 messages in full detail

This balances context compression (for token efficiency) with recent message visibility (for conversation continuity).

## Related Issues

- The summary itself was **appropriate and accurate** - it correctly summarized the conversation about holo/frequency search debugging
- PAPR generates summaries early (at 9 messages) - this is PAPR platform behavior, not a Paprwork issue
- Local SQLite had 10 messages, PAPR had 9 - the 10th message synced after the query

## Files Changed

- `src/gateway/services/storage/PaprMemoryProvider.ts` - Line 360: Changed `.slice(-6)` to `.slice(0, 6)`

## Related Docs

- `docs/MESSAGE_FLOW_LOGGING.md` - Comprehensive logging that helped identify this issue
- `docs/PAPR_TOOLCALLS_CONTEXT_FIX.md` - Previous PAPR message handling fix
