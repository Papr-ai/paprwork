# Send Button Stuck on "Stop" After Tool Call

**Issue:** When the agent's last action is a tool call (like `run_job`), the send button stays as "Stop" instead of changing back to "Send". This only happens when tools are the last thing in the response - if the agent adds text after tools, the button correctly changes to "Send".

**Date Fixed:** 2026-04-11

## Problem

### Behavior Observed

**Scenario 1 (Works Correctly):**
```
Agent: "Let me query the database..."
Tool: query_database → success
Agent: "Here are the results..."
```
→ Send button changes to "Send" ✅

**Scenario 2 (Broken):**
```
Agent: "Let me run the job..."
Tool: run_job → job starts running
(agent stream ends, no follow-up text)
```
→ Send button stays as "Stop" ❌

### Root Cause

The `streamAgent` generator in `AgentService.ts` **never yields a `done` chunk**. Instead, it:

1. Yields all chunks from the orchestrator (text, tools, etc.)
2. When orchestrator finishes (`next.done === true`), saves message to database
3. Then **just ends** without yielding a final `done` chunk

The `agent:complete` WebSocket message is sent by the handler AFTER the generator completes, but:
- When last chunk is **text** → Frontend updates with text → Then receives `agent:complete` → Processes `done` ✅
- When last chunk is **tool** → Frontend updates with tool → Then receives `agent:complete` → **Done handler might not trigger properly** ❌

## Solution

Yield an explicit `done` chunk from `streamAgent` **before** saving the message:

```typescript
// After the streaming loop ends (line 1269)

// 4. Save assistant message
const assistantMsg = createAssistantStoredMessage({...});
await this.storageManager.saveMessage(chatId, assistantMsg);

// 4.5. Yield done chunk to signal completion
yield {
  type: "done",
  chatId,
  payload: {},
  timestamp: new Date().toISOString(),
} as StreamChunk & { chatId: string };

// 5. Export chat to ~/Papr/ folder
```

This ensures the frontend always receives a `done` chunk to:
1. Finalize the streaming message
2. Clear `isSending` flag → Button changes to "Send"
3. Stop the timer
4. Remove animated indicators

## Files Changed

**`src/gateway/services/AgentService.ts`:**
- Added explicit `done` chunk yield after saving message (line 1283-1290)

## Impact

- **Before:** Button stuck as "Stop" when last action is tool call
- **After:** Button always changes to "Send" when agent finishes ✅
- **User Experience:** Clear indication that agent is done and user can send new message

## Testing

1. Send message that triggers job: "Run the People Verify job"
2. Wait for agent to finish (tool call is last action)
3. Verify send button changes from "Stop" to "Send"
4. Verify job continues running (visible in collapsed Working header)

## Related Issues

- Issue 47: Working Card Collapse Layout Shift
- Issue 48: Working Card Last Activity Display
- Issue 49: Message Loss on Quit During Job Execution
- WebSocket message flow timing
