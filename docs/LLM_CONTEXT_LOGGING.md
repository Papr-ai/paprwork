# LLM Context Logging - Debugging Missing Messages

**Date:** 2026-03-10
**Purpose:** Track exact messages sent to LLM to diagnose missing recent messages
**Status:** 🔍 DEBUGGING ENABLED

## What We Added

Comprehensive logging at two critical points where messages are sent to the LLM:

### 1. Pi-ai Path (OAuth - ChatGPT/Claude subscriptions)

**Location:** `src/gateway/services/AgentService.ts` line ~915

Logs AFTER `buildPiContext()` converts messages to pi-ai format, but BEFORE sending to `streamSimple()`:

```typescript
📤 [PI-AI] EXACT CONTEXT BEING SENT TO LLM
================================================================================
Model: gpt-5.2
Provider: openai-codex
Total messages: 15

Message breakdown:
  0. [user] "can you get one for me..."
  1. [assistant] "I can't create accounts..."
  2. [user] "yes this feels better..."  ← Should show newest messages!
  ...
  14. [user] "(older message)"

Tools available: 70
================================================================================
```

### 2. AI SDK Path (API keys - OpenAI/Anthropic/Google)

**Location:** `src/gateway/services/AgentService.ts` line ~995

Logs AFTER all processing (truncation, prepareStep, etc.) but BEFORE calling `streamText()`:

```typescript
📤 [AI SDK] EXACT CONTEXT BEING SENT TO LLM
================================================================================
Model: claude-sonnet-4-6
Provider: anthropic
Total messages: 17

Message breakdown:
  0. [system] You are a helpful AI assistant...
  1. [user] "can you get one for me..."
  2. [assistant] 2 text parts, 0 tool-calls
  3. [user] "yes this feels better..."  ← Should show newest messages!
  ...
  16. [user] "(current message)"

Tools available: 70
Max tokens: 16000
Max steps: custom
================================================================================
```

## How to Use This

### Step 1: Start Fresh Session
Restart the app to get clean logs:
```bash
npm start
```

### Step 2: Send Message in Problematic Chat
Send a new message in the chat where you're seeing old messages in Context Inspector.

### Step 3: Check Gateway Logs

Look for the logging block starting with `📤 [PI-AI]` or `📤 [AI SDK]`.

**What to verify:**

1. **Message Count**: Does the total match what you expect?
   - If summary exists, should be ~15 recent messages
   - If no summary, should be all messages

2. **Message Order**: Are messages in chronological order?
   - Should go oldest → newest
   - Your current message should be last (or second-to-last if assistant already replied)

3. **Message Content**: Are the newest messages present?
   - Look for your most recent messages in the breakdown
   - Compare with what you see in the UI

### Step 4: Compare with Storage Logs

Also check the storage logs we added earlier:

```
[LocalStorage] 💾 Saving message to chat abc123:
  timestamp: "2026-03-10T12:34:56.789Z"
  contentPreview: "yes this feels better..."

[LocalStorage] 🔍 Query returned 15 messages (DESC order):
  0. [2026-03-10T12:34:56.789Z] user: "yes this feels better..."
  1. [2026-03-10T12:30:00.000Z] assistant: "I can't create..."
```

This shows:
1. What was saved to DB
2. What was loaded from DB
3. What the LLM actually received

## What to Look For

### Scenario 1: Message Missing from Storage Query

If the newest message is NOT in the storage query:
```
[LocalStorage] 🔍 Query returned 15 messages (DESC order):
  0. [OLD TIMESTAMP] assistant: "I can't create..."  ← WRONG! Should be newest
```
**Problem:** Database query or timestamp issue

### Scenario 2: Message Missing from LLM Context

If the message IS in storage but NOT sent to LLM:
```
[LocalStorage] Query: Shows newest message ✓
[PI-AI] EXACT CONTEXT: Missing newest message ✗
```
**Problem:** Message filtering between storage and LLM (buildPiContext, buildModelMessages, etc.)

### Scenario 3: Wrong Messages in LLM Context

If the LLM gets completely different messages:
```
[LocalStorage] Query: Messages 36-50
[PI-AI] EXACT CONTEXT: Messages 1-15  ← WRONG range!
```
**Problem:** Wrong query or stale cache

## Code Flow Recap

**Full message flow from user input to LLM:**

```
User sends "hello"
    ↓
AgentService.streamAgent() saves to DB
    ↓
[LocalStorage] 💾 Saving message... (line 208)
    ↓
AgentService loads history from DB
    ↓
[LocalStorage] 🔍 Query returned X messages... (line 371)
    ↓
buildModelMessages() formats for AI SDK
    ↓
buildPiContext() converts to pi-ai format (OAuth only)
    ↓
📤 [PI-AI/AI SDK] EXACT CONTEXT BEING SENT (line 915 or 995)
    ↓
streamSimple() or streamText() sends to API
```

## Files Modified

1. **src/gateway/services/AgentService.ts**
   - Added logging before pi-ai call (line ~915)
   - Added logging before AI SDK call (line ~995)

2. **src/gateway/services/storage/LocalStorageProvider.ts**
   - Added logging in saveMessage() (line 208)
   - Added logging in loadMessagesForLLM() (line 360-380)

## Expected Output Example

For a healthy conversation, logs should show:

```bash
# User sends message
[LocalStorage] 💾 Saving message to chat abc123:
  timestamp: "2026-03-10T15:30:00.000Z"
  contentPreview: "yes this feels better..."
[LocalStorage] ✅ Message saved successfully

# Agent loads history
[LocalStorage] 🔍 Query returned 15 messages (DESC order):
  0. [2026-03-10T15:30:00.000Z] user: "yes this feels better..."  ← Newest!
  1. [2026-03-10T15:25:00.000Z] assistant: "I can't create..."
  2. [2026-03-10T15:20:00.000Z] user: "can you get one..."
  ... (12 more older messages)

[LocalStorage] Loading LLM context for chat abc123:
  Total messages in DB: 50
  Archived (in summary): 35
  Recent (loaded): 15
  Summary exists: true

# Agent sends to LLM
📤 [PI-AI] EXACT CONTEXT BEING SENT TO LLM
================================================================================
Total messages: 15

Message breakdown:
  0. [user] "can you get one..."
  1. [assistant] "I can't create..."
  2. [user] "yes this feels better..."  ← Newest message present!
  ...
  14. [user] "(current message)"
================================================================================
```

## Next Steps

Once we see the logs, we can identify:
1. **WHERE** messages are being lost (storage query vs. formatting)
2. **WHEN** messages are being lost (timestamp issue vs. query issue)
3. **WHY** messages are being lost (code bug vs. data corruption)

Then we can apply a surgical fix to the exact point where the problem occurs.
