# Context Inspector Fixes

**Date:** 2026-03-08

## Summary

Fixed three critical bugs in the context inspector that prevented it from showing exactly what the LLM sees. The inspector now accurately displays the model, message history, and conversation summaries.

---

## Issues Fixed

### Issue 1: Context Card Showing Wrong Model ✅

**Problem:** The context inspector displayed the model selected in the UI dropdown, not the actual model being used by the active chat session.

**Root Cause:** `inspectContext()` used the `selectedModel` parameter from the UI instead of checking the active session's config.

**Fix:** Check for active session and use `session.config.model` if it exists.

**Files Changed:**
- `src/gateway/services/AgentService.ts` - Get model from session
- `src/gateway/services/ChatSessionManager.ts` - Added `getSessionIfExists()` helper

---

### Issue 2: Message History Showing in Wrong Order ✅

**Problem:** When a conversation had a summary, it appeared AFTER recent messages instead of BEFORE them, making it seem like old messages were prioritized.

**Root Cause:** `buildModelMessages()` used `.push()` to add the summary at the end. The comment said "BEFORE" but the code did "AFTER"!

**Fix:** Use `.splice()` to insert summary right after system prompt (correct position).

**Files Changed:**
- `src/gateway/services/agent/historyFormatter.ts` - Fixed insertion order

**Correct order now:**
1. System prompt
2. Conversation summary (if exists)
3. Recent message history (last 15-50 messages)
4. New user message placeholder

---

### Issue 3: Missing Messages and Summary (Code Path Mismatch) ✅ **CRITICAL**

**Problem:** Context inspector was missing 6-7 recent messages AND not showing the conversation summary, even though summarization had run.

**Root Cause - Code Path Divergence:**

The agent run and context inspector used DIFFERENT methods to extract summaries:

**Agent run (CORRECT):**
```typescript
const historyRaw = await this.storageManager.loadMessagesForLLM(chatId);

// Extract __summary marker from historyRaw
const history = historyRaw.filter((msg) => {
  if (typeof msg === "object" && msg !== null && "__summary" in msg) {
    conversationSummary = (msg as { __summary: string }).__summary;
    return false; // Remove from history array
  }
  return true;
});
```

**Context inspector (WRONG):**
```typescript
const history = await this.storageManager.loadMessagesForLLM(chatId);

// Try to read from chat metadata (doesn't match what LLM sees!)
const chat = await this.storageManager.getChat(chatId);
conversationSummary = chatAny.summary_long;
```

The `loadMessagesForLLM()` method returns:
```typescript
[
  { __summary: "..." },  // Special marker object
  { role: "user", content: "..." },
  { role: "assistant", content: "..." },
  // ... last 15 messages ...
]
```

The context inspector was:
1. Not extracting the `__summary` object
2. Counting it as a regular message
3. Reading summary from different source (chat metadata)

**Fix:** Use the EXACT same logic as the agent run - filter `historyRaw` and extract `__summary`.

**Files Changed:**
- `src/gateway/services/AgentService.ts` - Match agent run logic

**Impact:**
- Context inspector now shows EXACTLY what the LLM sees
- Summary correctly extracted and displayed
- All recent messages included
- Accurate message counts

---

## The __summary Pattern

Storage providers inject summaries using a special marker:

```typescript
// Provider returns:
[
  { __summary: "summary text..." },  // Special marker
  { role: "user", content: "..." },
  // ... recent messages ...
]

// Consumer must extract it:
const history = historyRaw.filter(msg => {
  if ("__summary" in msg) {
    summary = msg.__summary;
    return false; // Remove from array
  }
  return true; // Keep in array
});
```

This pattern requires consistent handling across all consumers!

---

## Testing Verification

1. **Model Display:**
   - Change model dropdown but don't send message
   - Open context inspector → should show old model (session model)
   - Send message → session recreates
   - Open inspector → should show new model

2. **Message Order:**
   - Long conversation (100+ messages triggers summarization)
   - Open context inspector
   - Verify order: System → Summary → Recent Messages → Placeholder

3. **Summary Extraction:**
   - Have 50+ message conversation
   - Wait for "Conversation summarized" notification
   - Open context inspector
   - Verify: Summary in its own section
   - Verify: Message count = 15 recent + 1 placeholder (if summary exists)
   - Verify: All UI messages also in inspector

---

## Key Learnings

1. **Use session state, not UI state** - UI shows intent, session shows reality
2. **Order matters** - Summary before recent messages for proper context
3. **Code path consistency is critical** - Inspector must match agent run exactly
4. **Don't assume data structures** - `loadMessagesForLLM()` has special format
5. **Comments can lie** - Always verify code matches comments

---

## Related Files

- `src/gateway/services/AgentService.ts` - Agent run + context inspector
- `src/gateway/services/ChatSessionManager.ts` - Session management
- `src/gateway/services/agent/historyFormatter.ts` - Message formatting
- `src/gateway/services/storage/LocalStorageProvider.ts` - SQLite storage (injects `__summary`)
- `src/gateway/services/storage/PaprMemoryProvider.ts` - Cloud storage (injects `__summary`)
- `ui/components/Chat/ContextInspectorModal.tsx` - UI component
- `src/gateway/websocket/chat.ts` - WebSocket handler
