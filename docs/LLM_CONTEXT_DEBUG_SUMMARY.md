# Summary: LLM Context Debugging Setup

## What We Did

Added comprehensive logging to track the **exact messages sent to the LLM** at three critical points:

### 1. When Messages Are Saved to Database
**File:** `src/gateway/services/storage/LocalStorageProvider.ts` (line ~208)

Shows:
- Message timestamp
- Content preview
- Role (user/assistant)

### 2. When Messages Are Loaded from Database
**File:** `src/gateway/services/storage/LocalStorageProvider.ts` (line ~360)

Shows:
- All 15 messages in DESC order (newest first)
- Each message's timestamp and content preview
- Total message count in DB
- How many are archived vs. recent

### 3. Right Before Sending to LLM
**File:** `src/gateway/services/AgentService.ts` (lines ~915 and ~995)

Shows:
- **EXACT** message array being sent to the API
- Message breakdown with role and content preview
- Total message count
- Tools available

## Why This Matters

You reported that after summarization happens, **old messages show up in context instead of new ones**. This logging will tell us:

1. **Are messages being saved correctly?** (with correct timestamps)
2. **Are messages being loaded correctly?** (in correct order)
3. **Are messages being sent to LLM correctly?** (without filtering/truncation errors)

## How to Test

1. **Restart the app** to get clean logs
2. **Send a message** in the problematic chat (the one with summary)
3. **Check Gateway logs** for these sections:
   - `[LocalStorage] 💾 Saving message...`
   - `[LocalStorage] 🔍 Query returned X messages...`
   - `📤 [PI-AI] EXACT CONTEXT...` or `📤 [AI SDK] EXACT CONTEXT...`

## What to Look For

**Good output:**
```
[LocalStorage] 🔍 Query returned 15 messages (DESC order):
  0. [2026-03-10T15:30:00.000Z] user: "yes this feels better..."  ← NEWEST
  1. [2026-03-10T15:25:00.000Z] assistant: "I can't create..."
  ...

📤 [PI-AI] EXACT CONTEXT BEING SENT TO LLM
Total messages: 15
  0. [user] "can you get one..."
  1. [assistant] "I can't create..."
  2. [user] "yes this feels better..."  ← NEWEST message present!
```

**Bad output (what you're probably seeing):**
```
[LocalStorage] 🔍 Query returned 15 messages (DESC order):
  0. [OLD DATE] assistant: "I can't create..."  ← OLD message first!
  1. [OLDER DATE] user: "can you get one..."
  ...

📤 [PI-AI] EXACT CONTEXT BEING SENT TO LLM
Total messages: 15
  0. [user] "can you get one..."
  1. [assistant] "I can't create..."  ← Missing newer messages!
```

## Expected Fix

Once we see the logs, we'll know if the issue is:

1. **Timestamp Issue** - Messages getting wrong timestamps (easy fix: timestamp generation)
2. **Query Issue** - SQL query returning wrong messages (fix: query logic)
3. **Filtering Issue** - Messages being filtered out between DB and LLM (fix: filtering logic)
4. **Caching Issue** - Stale chat metadata (fix: refresh metadata after save)

## Files Changed

- `src/gateway/services/storage/LocalStorageProvider.ts` - Added save/load logging
- `src/gateway/services/AgentService.ts` - Added LLM context logging
- `docs/LLM_CONTEXT_LOGGING.md` - Detailed documentation
- `docs/HISTORY_LOADING_INVESTIGATION.md` - Investigation notes

Ready to test! 🔍
