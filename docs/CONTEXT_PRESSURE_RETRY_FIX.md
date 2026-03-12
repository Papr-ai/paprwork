# Context Pressure Retry Fix

**Date:** 2026-03-09

## Critical Bug Fixed

When context pressure triggered mid-conversation (during tool calls), the agent would see the same user request multiple times and not recognize its own completed work.

---

## The Problem

### Symptom
User sees the agent "starting over" after compression:
```
→ App file read ✓
→ App file read ✓
→ App files listed ✓
→ Ran: cd ~/PAPR/apps/... ✓

[Compression happens]

Pen: "Contemplating..."
"Let me read everything to get the full picture — the ICP definitions, Plan tab, and current rendering."
→ App file read ✓  ← READING AGAIN!
→ App file read ✓  ← ALREADY DID THIS!
```

### Root Cause

When context window reached ~120K tokens during active tool usage:

1. **Abort stream** - Stop current generation
2. **Save partial work** - Assistant message with all completed tool calls
3. **Compress conversation** - Summarize to free up context
4. **Retry with SAME user message** - ❌ BUG!

The retry code was:
```typescript
for await (const chunk of this.streamAgent(
  chatId,
  userMessage,  // ← ORIGINAL message sent AGAIN
  config,
  options,
)) {
  yield chunk;
}
```

This caused the history to look like:
```
[Compressed summary]
User: "Fix the app"       ← Original request
Assistant: [partial work] ← Tool calls done
User: "Fix the app"       ← DUPLICATE from retry!
```

The agent saw two identical user requests and didn't recognize that it had already done partial work.

---

## The Fix

Changed the retry to send a **continuation prompt** instead of the original message:

```typescript
// Create a continuation message that acknowledges the partial work
const continuationPrompt = "Continue from where you left off. You've already made progress on this task.";

// Recursively call streamAgent with continuation prompt
for await (const chunk of this.streamAgent(
  chatId,
  continuationPrompt,  // ← NEW continuation message
  config,
  options,
)) {
  yield chunk;
}
```

Now the history looks like:
```
[Compressed summary]
User: "Fix the app"                           ← Original request
Assistant: [partial work with 10 tool calls]  ← Saved work
User: "Continue from where you left off..."   ← Continuation prompt
```

The agent can now:
- ✅ See its own completed work
- ✅ Understand it's a continuation, not a fresh start
- ✅ Pick up where it left off without re-reading everything

---

## Impact

### Before
- Agent re-reads files it already read
- Wastes tokens and time
- User confused by redundant work
- Progress lost on compression

### After
- Agent sees its completed tool calls
- Continues efficiently from last state
- User sees smooth continuation
- Progress preserved across compression

---

## Context Pressure Flow (Complete)

1. **Detection** (120K prompt tokens)
   ```
   [AgentService] ⚠️ Context pressure CRITICAL (121,543 tokens)
   [AgentService] Aborting stream to prevent context_length_exceeded
   ```

2. **Abort & Save**
   ```
   [AgentService] 🏁 Stream finished (aborted due to context pressure)
   ✓ Saved partial response before retry
   ```

3. **Compression**
   ```
   🔄 Starting compression for chat abc123
   ✓ Compression complete for chat abc123
   ```

4. **Continuation**
   ```
   🔄 Automatically retrying with compressed context...
   [AgentService] 📨 New message: "Continue from where you left off..."
   ```

5. **Resume Work**
   ```
   [AgentService] 📚 Loaded 15 messages (50 archived in summary)
   Agent sees: Original request + Partial work + Continuation prompt
   ```

---

## Files Changed

- `src/gateway/services/AgentService.ts` - Lines 1073-1091 (retry logic)

---

## Testing

To test this fix:
1. Start a complex task with many tool calls (15+)
2. Watch for context pressure abort (~120K tokens)
3. Verify compression happens
4. Verify continuation message is sent (not original)
5. Verify agent acknowledges completed work
6. Verify no redundant tool calls

---

## Related Issues

- Context pressure threshold: 120K tokens (conservative for 200K window)
- Summarization trigger: 50K tokens (background, non-blocking)
- This fix only applies to context pressure aborts during streaming
- Background summarization (line 1140) doesn't have this issue

---

## Future Improvements

Consider:
1. **Smarter continuation prompts** - Include summary of what was done
2. **Checkpoint system** - Save intermediate state during long operations
3. **Progress indicators** - Show user when compression is happening
4. **Adaptive thresholds** - Adjust 120K based on model's actual context window
