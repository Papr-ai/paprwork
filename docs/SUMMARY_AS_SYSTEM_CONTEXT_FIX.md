# Summary as System Context Fix

**Date:** 2026-02-19  
**Issue:** Agent responding with stale context even when user's message was in recent messages

## Root Cause Analysis

The issue wasn't just the 6-message limit - even if the user's message was in the last 6 messages, the agent was still getting confused. The actual problem was **where the summary was being injected**.

### The Problem

**Before Fix:**
```
Message flow to LLM:
1. System Prompt: "You are Paprwork..."
2. User: "📚 ARCHIVED CONVERSATION SUMMARY... ⚠️ DO NOT respond to this..." ← PROBLEM!
3. User: message from 6 turns ago
4. Assistant: response
5. ...
6. User: YOUR LATEST MESSAGE ← Should respond to this!
```

The summary was injected as a **user message** at the start of history. Even with clear instructions "DO NOT respond to this summary", the LLM would sometimes treat it as the most important user input because:
- It was first in the conversation flow
- It was the longest user message (500+ chars)
- It contained a lot of context and information

### The Solution

**After Fix:**
```
System Prompt:
"You are Paprwork...

# Conversation Context

This conversation has been ongoing for 144 messages total.
The summary below covers the first 94 messages.
The actual recent 50 messages follow this summary.

📚 ARCHIVED CONVERSATION SUMMARY (94 older messages archived)
[Full summary here...]
"

Message flow to LLM:
1. [System Prompt with embedded summary]
2. User: message from 50 turns ago
3. Assistant: response
4. ...
5. User: YOUR LATEST MESSAGE ← Responds correctly!
```

The summary is now part of the **system prompt**, not a user message. This makes it clear it's background context, not something to respond to.

## Changes Made

### 1. Storage Providers (LocalStorageProvider.ts & PaprMemoryProvider.ts)

**Before:**
```typescript
return [
  {
    role: 'user',  // ❌ Treated as user message
    content: summaryText
  },
  ...recentMessages
];
```

**After:**
```typescript
return [
  { __summary: summaryText },  // ✅ Special metadata
  ...recentMessages
];
```

The `__summary` property is a special marker that `AgentService` extracts and removes from history.

### 2. AgentService.ts

**Extract summary from history:**
```typescript
// Extract summary if present (injected by storage providers)
let conversationSummary: string | undefined;
const history = historyRaw.filter((msg) => {
  if (typeof msg === 'object' && msg !== null && '__summary' in msg) {
    conversationSummary = (msg as { __summary: string }).__summary;
    return false; // Remove from history
  }
  return true; // Keep in history
});
```

**Pass to system prompt:**
```typescript
const systemPrompt = await this.buildContextualSystemPrompt(
  chatId, 
  history, 
  enabledSkills, 
  conversationSummary  // ✅ Now included
);
```

### 3. SystemPrompt.ts (Already Had Infrastructure!)

The `SystemPromptOptions` interface already had `conversationSummary?: string` defined (line 35), and the builder already knew how to inject it properly as part of the system context (lines 1458-1465). We just weren't using it!

## Benefits

### 1. **Clear Role Separation**
- System prompt = instructions + background context
- User messages = actual user input to respond to
- No more confusion about what to respond to

### 2. **Better LLM Understanding**
The LLM sees:
```
System: [You are an agent. Here's what happened earlier: ...]
User: [Their actual current question]
```

Instead of:
```
User: [Here's a summary, don't respond to it]
User: [... several messages ...]
User: [Their actual current question]  ← Which one to respond to?
```

### 3. **Follows Best Practices**
- OpenAI, Anthropic, and Google all recommend putting persistent context in the system prompt
- User messages should be things the user actually wants a response to
- System prompt is for instructions that don't change turn-to-turn

## Additional Fix: Increased Message Window

While fixing the summary injection, we also increased the recent message window from 6 to 50 messages:

```typescript
// Before
LIMIT 6  // Only 6 recent messages

// After  
LIMIT 50  // 50 recent messages (~16K tokens)
```

This provides better recent context without hitting token limits.

## Testing

To verify the fix works:

1. Start a long conversation (50+ messages)
2. Wait for summary to generate
3. Ask a question referring to something in the last 10 messages
4. Agent should respond to YOUR question, not summarize the summary

## Files Modified

```
✅ src/gateway/services/storage/LocalStorageProvider.ts
   - Inject summary as `{ __summary: ... }` instead of user message
   - Updated formatting to remove "DO NOT respond" warnings (not needed)
   - Increased message window: 6 → 50

✅ src/gateway/services/storage/PaprMemoryProvider.ts
   - Same changes as LocalStorageProvider

✅ src/gateway/services/AgentService.ts
   - Extract `__summary` from history before processing
   - Pass `conversationSummary` to buildContextualSystemPrompt
   - Updated method signature

✅ src/core/agents/SystemPrompt.ts
   - Already had infrastructure! Just started using it.
```

## Impact

- **No breaking changes** - Works with or without summary
- **No new dependencies** - Uses existing architecture
- **Type-safe** - Full TypeScript support
- **Backward compatible** - Old chats without summaries work fine

## Future Improvements

1. **Token-based limiting**: Instead of fixed 50 messages, dynamically adjust based on message sizes
2. **Smart summary placement**: Put summary in system prompt for long conversations, skip for short ones
3. **Summary metadata**: Include timestamp of when summary was generated
4. **Progressive summarization**: Generate summaries at 50, 100, 200 messages with different detail levels

---

**Key Lesson:** When instructing an LLM "don't do X", it's better to architect the solution so it doesn't see X in a problematic context, rather than relying on instructions alone.
