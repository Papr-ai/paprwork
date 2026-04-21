# Message Flow Logging Guide

**Date:** 2026-04-19
**Purpose:** Comprehensive logging to track messages through the entire pipeline

## Overview

Added detailed logging at three critical stages to track how messages flow from PAPR → Storage → LLM. This helps debug any issues with message roles, content, or formatting.

## The Three Stages

### 🟢 STAGE 1: LOADING MESSAGES FROM PAPR
**Location:** `PaprMemoryProvider.loadMessagesForLLM()`

**What it logs:**
- Total messages retrieved from PAPR API
- Whether PAPR has a summary available
- Whether `context_for_llm` is present
- Role distribution (user vs assistant counts)
- Detailed list of ALL messages with timestamps and content previews
- Which messages are selected for LLM (when summary exists, takes last 6)
- Role distribution after filtering
- Final result preview showing what's being returned

**Example output:**
```
================================================================================
🟢 STAGE 1: LOADING MESSAGES FROM PAPR (Chat: 95992479-4fe0...)
================================================================================
[STAGE 1] Retrieved 6 messages from PAPR API
[STAGE 1] Total count in chat: 6
[STAGE 1] Has summary: false
[STAGE 1] Has context_for_llm: true
[STAGE 1] First message: [2026-04-19T18:33:27.404Z] user
[STAGE 1] Last message: [2026-04-20T04:10:22.505Z] assistant
[STAGE 1] Role distribution from PAPR: { user: 3, assistant: 3 }
[STAGE 1] Detailed message list from PAPR:
  [0] user       | 18:33:27 | in memory project in github folder on this mac...
  [1] assistant  | 18:42:04 | Let me find the project and check the context...
  [2] user       | 04:08:59 | got it, can we do a test for search with holo...
  [3] user       | 04:09:56 | stop...
  [4] assistant  | 04:09:59 | Stopped. What would you like to do next?...
  [5] assistant  | 04:10:22 | Let me gather context first - the project code...
[STAGE 1] ✅ No summary, returning all 6 messages
================================================================================
```

### 🔵 STAGE 2: LOADING MESSAGES FOR UI
**Location:** `PaprMemoryProvider.loadMessages()`

**What it logs:**
- Request parameters (limit, skip)
- Total messages retrieved
- Role distribution from PAPR
- Detailed list of messages (newest first from PAPR)
- Note that messages will be reversed for chronological UI display
- Final result with role distribution after reversal
- First 5 messages that will be shown in UI

**Example output:**
```
================================================================================
🔵 STAGE 2: LOADING MESSAGES FOR UI (Chat: 95992479-4fe0...)
================================================================================
[STAGE 2] Requesting messages: limit=100, skip=0
[STAGE 2] Retrieved 6 messages from PAPR API
[STAGE 2] Role distribution from PAPR: { user: 3, assistant: 3 }
[STAGE 2] Messages (newest first from PAPR, will reverse for UI):
  [0] assistant  | 04:10:22 | Let me gather context first...
  [1] assistant  | 04:09:59 | Stopped. What would you like to do next?...
  [2] user       | 04:09:56 | stop...
  [3] user       | 04:08:59 | got it, can we do a test for search...
  [4] assistant  | 18:42:04 | Let me find the project and check...
  [5] user       | 18:33:27 | in memory project in github folder...
[STAGE 2] ✅ Returning 6 messages to UI (chronological order)
[STAGE 2] Role distribution for UI: { user: 3, assistant: 3 }
[STAGE 2] First 5 messages for UI:
  [0] user       | 18:33:27 | in memory project in github folder on this mac...
  [1] assistant  | 18:42:04 | Let me find the project and check the context...
  [2] user       | 04:08:59 | got it, can we do a test for search with holo...
  [3] user       | 04:09:56 | stop...
  [4] assistant  | 04:09:59 | Stopped. What would you like to do next?...
================================================================================
```

### 🔵 STAGE 2.5: MESSAGES RECEIVED FROM STORAGE
**Location:** `AgentService.streamText()` - after `loadMessagesForLLM()`

**What it logs:**
- Total items received from storage
- Whether a `__summary` object is present
- Item distribution (user, assistant, __summary)
- First 5 items with timestamps and content
- Summary extraction confirmation
- Role distribution after summary removal
- Last 5 messages that will go to LLM

**Example output:**
```
================================================================================
🔵 STAGE 2.5: MESSAGES RECEIVED FROM STORAGE (Before LLM formatting)
================================================================================
[STAGE 2.5] Received 7 items from storage
[STAGE 2.5] Contains __summary object: true
[STAGE 2.5] Item distribution: { __summary: 1, user: 3, assistant: 3 }
[STAGE 2.5] First 5 items from storage:
  [0] __summary (1247 chars)
  [1] user       | 18:33:27 | in memory project in github folder on this mac...
  [2] assistant  | 18:42:04 | Let me find the project and check the context...
  [3] user       | 04:08:59 | got it, can we do a test for search with holo...
  [4] user       | 04:09:56 | stop...
[STAGE 2.5] ✅ Extracted summary (1247 chars)
[STAGE 2.5] After extracting summary: 6 messages
[STAGE 2.5] Role distribution (no summary): { user: 3, assistant: 3 }
[STAGE 2.5] Last 5 messages going to LLM:
  [1] assistant  | 18:42:04 | Let me find the project and check the context...
  [2] user       | 04:08:59 | got it, can we do a test for search with holo...
  [3] user       | 04:09:56 | stop...
  [4] assistant  | 04:09:59 | Stopped. What would you like to do next?...
  [5] assistant  | 04:10:22 | Let me gather context first - the project code...
================================================================================
```

### 🟡 STAGE 3: SENDING CONTEXT TO LLM
**Location:** `AgentService.streamText()` - after `buildPiContext()`

**What it logs:**
- Model and provider being used
- Total messages in context
- System prompt length
- Available tools count
- Role distribution in pi-ai formatted context
- First 5 messages (oldest)
- Last 10 messages (newest)
- Shows both string content and complex array content

**Example output:**
```
================================================================================
🟡 STAGE 3: SENDING CONTEXT TO LLM (PI-AI)
================================================================================
[STAGE 3] Model: claude-sonnet-4-6
[STAGE 3] Provider: anthropic
[STAGE 3] Total messages: 6
[STAGE 3] System prompt length: 45234 chars
[STAGE 3] Tools available: 95
[STAGE 3] Role distribution in context: { user: 3, assistant: 3 }

[STAGE 3] FIRST 5 MESSAGES (should be oldest):
────────────────────────────────────────────────────────────────────────────────
  [0] user         | ts:1776658500000 | in memory project in github folder on this mac, we need to fix se...
  [1] assistant    | ts:1776658500000 | Array[1]: {"type":"text","text":"Let me find the project and che...
  [2] user         | ts:1776658500000 | got it, can we do a test for search with holo and frequencies to...
  [3] user         | ts:1776658500000 | stop...
  [4] assistant    | ts:1776658500000 | Array[1]: {"type":"text","text":"Stopped. What would you like to...

[STAGE 3] LAST 10 MESSAGES (should be newest):
────────────────────────────────────────────────────────────────────────────────
  [0] user         | ts:1776658500000 | in memory project in github folder on this mac...
  [1] assistant    | ts:1776658500000 | Array[1]: {"type":"text","text":"Let me find the project...
  [2] user         | ts:1776658500000 | got it, can we do a test for search...
  [3] user         | ts:1776658500000 | stop...
  [4] assistant    | ts:1776658500000 | Array[1]: {"type":"text","text":"Stopped. What would...
  [5] assistant    | ts:1776658500000 | Array[1]: {"type":"text","text":"Let me gather context...
================================================================================
```

## What to Look For

### Healthy Flow
1. **STAGE 1**: Should show equal user/assistant counts (or close)
2. **STAGE 2**: Same messages, just reversed order for UI
3. **STAGE 2.5**: Summary extracted properly, message counts match
4. **STAGE 3**: All messages formatted with proper roles (no all-user issue)

### Problem Indicators

**Problem:** All messages showing as "user" in STAGE 3
- **Check:** STAGE 1 and STAGE 2 - do they show correct roles?
- **If yes:** Problem is in `buildPiContext()` formatting
- **If no:** Problem is in PAPR API response or parsing

**Problem:** Messages missing between stages
- **Check:** Count drops between STAGE 1 → STAGE 2.5
- **If drops:** Problem in storage provider filtering/slicing
- **Check:** Content changes between stages
- **If yes:** Problem in `parseMessageForLLM()`

**Problem:** Summary not extracted
- **Check:** STAGE 2.5 shows `__summary` present but not extracted
- **If yes:** Problem in `filter()` logic in AgentService
- **Check:** STAGE 1 doesn't show summary even though PAPR has one
- **If yes:** Problem in PaprMemoryProvider summary logic

**Problem:** Timestamps all the same
- **Check:** STAGE 3 shows unified timestamp (this is EXPECTED)
- **Reason:** `buildPiContext()` assigns `Date.now()` to all messages
- **Not a bug:** This is how pi-ai context works

## Files Modified

1. `src/gateway/services/storage/PaprMemoryProvider.ts`
   - Enhanced `loadMessagesForLLM()` - STAGE 1 logging
   - Enhanced `loadMessages()` - STAGE 2 logging

2. `src/gateway/services/AgentService.ts`
   - Enhanced message loading section - STAGE 2.5 logging
   - Enhanced pi-ai context logging - STAGE 3 logging

## Testing

To see the full flow:
1. Start the app: `npm start`
2. Send a message in a chat with history
3. Check terminal logs for the three stages
4. Verify roles are correct at each stage
5. Verify message counts match through the pipeline

## Related Issues

- [TITLE_GEN_AND_PAPR_ERROR_ANALYSIS.md](./TITLE_GEN_AND_PAPR_ERROR_ANALYSIS.md) - Original investigation
- [PAPR_TOOLCALLS_CONTEXT_FIX.md](./PAPR_TOOLCALLS_CONTEXT_FIX.md) - Tool calls parsing fix
