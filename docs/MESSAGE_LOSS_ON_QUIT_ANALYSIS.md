# Message Loss on App Quit During Job Execution

**Issue:** When a user closes the app while an agent job is running, the assistant's message (including tool calls and partial response) can be lost because it hasn't been persisted to the database yet.

**Date Identified:** 2026-04-11

## Problem Flow

1. Agent streams response and calls `run_job` tool
2. Agent's LLM stream ends → Gateway sends `done` chunk
3. Frontend receives `done` → Updates UI state (message finalized)
4. **Job continues running** in background
5. User closes app (Cmd+Q)
6. App quit sequence:
   - `before-quit` event fires
   - OAuth/Ollama cleanup
   - Gateway supervisor stops
   - App quits after 100ms
7. **Result:** Message only exists in frontend state, never saved to database

## Root Causes

### 1. Message Saved Too Late
```typescript
// AgentService.ts line 1282
await this.storageManager.saveMessage(chatId, assistantMsg);
```
This happens **AFTER** the entire stream generator completes, which includes:
- All LLM output
- All tool executions
- Any job completions

If the app quits before the generator finishes, the save never happens.

### 2. No Emergency Save on Quit
The `before-quit` handler doesn't trigger any message persistence. It only:
- Cleans up OAuth servers
- Cleans up Ollama
- Stops Gateway supervisor

There's no "flush pending messages" step.

### 3. Frontend State is Ephemeral
The finalized message in `chatStates` (Zustand store) is only in memory. When the app quits, this state is lost.

## Proposed Solutions

### **Solution 1: Save on `done` Chunk** (Recommended)

Save the message immediately when the stream ends, even if jobs are still running.

**Changes needed:**

**`AgentService.ts`:**
```typescript
case "done": {
  // Save message immediately when stream ends
  const assistantMsg: StoredMessage = createAssistantStoredMessage({
    chatId,
    model: config.model,
    assistantText,
    thinkingText,
    toolCalls,
    toolResults,
    sequence,
    usage: tokenUsage,
  });
  await this.storageManager.saveMessage(chatId, assistantMsg);
  console.log(`✓ Saved message on stream completion`);
  
  yield { type: "done", payload: {} };
  break;
}
```

**Pros:**
- Simple, immediate persistence
- Works even if user quits right after agent finishes
- No additional complexity

**Cons:**
- If job delivers results later, need to update the message
- Requires message update logic for job completion

---

### **Solution 2: Periodic Auto-Save During Stream**

Save partial message every N seconds during streaming.

**Changes needed:**

**`AgentService.ts`:**
```typescript
let lastSaveTime = Date.now();
const SAVE_INTERVAL_MS = 5000; // Save every 5 seconds

// Inside stream loop
if (Date.now() - lastSaveTime > SAVE_INTERVAL_MS) {
  const partialMsg: StoredMessage = createAssistantStoredMessage({
    chatId,
    model: config.model,
    assistantText,
    thinkingText,
    toolCalls,
    toolResults,
    sequence,
    usage: tokenUsage,
  });
  await this.storageManager.saveMessage(chatId, partialMsg);
  lastSaveTime = Date.now();
}
```

**Pros:**
- Frequent backups during long operations
- Protects against crashes/freezes
- User never loses more than 5s of work

**Cons:**
- More database writes
- Slightly more complex
- Multiple versions of same message

---

### **Solution 3: Emergency Save on Quit**

Add message flush to `before-quit` handler.

**Changes needed:**

**`src/electron/index.cjs`:**
```javascript
app.on("before-quit", async (event) => {
  event.preventDefault();
  
  // NEW: Flush pending messages via Gateway
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log("[Electron] Flushing pending messages...");
    mainWindow.webContents.send("app:flush-messages");
    // Wait 500ms for flush
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Existing cleanup...
  if (supervisor) supervisor.stop();
  setTimeout(() => app.quit(), 100);
});
```

**`ui/App.tsx`:**
```typescript
useEffect(() => {
  const handleFlush = () => {
    // Get all streaming messages and force-finalize them
    const chatStates = useChatStore.getState().chatStates;
    chatStates.forEach((state, chatId) => {
      const streamingMsg = state.messages.find(m => m.isStreaming);
      if (streamingMsg) {
        // Send "emergency finalize" to Gateway
        gateway.send("agent:emergency-save", {
          chatId,
          messageId: streamingMsg.id,
        });
      }
    });
  };
  
  window.electronAPI.onAppFlushMessages(handleFlush);
}, []);
```

**Pros:**
- Catches edge cases
- No performance impact during normal operation
- Good safety net

**Cons:**
- Complex coordination
- Tight timing (500ms might not be enough)
- Requires IPC plumbing

---

## Recommended Approach: **Solution 1 + Solution 3**

**Hybrid strategy:**
1. **Primary:** Save message on `done` chunk (Solution 1)
2. **Backup:** Emergency flush on quit (Solution 3)

This gives us:
- ✅ Immediate persistence when agent finishes
- ✅ Safety net for unexpected quits
- ✅ Job results can update message later (via message patching)

## Message Update Flow (for Job Completion)

When a job completes and needs to update the message:

```typescript
// Add to StorageProvider interface
async updateMessage(chatId: string, messageId: string, updates: Partial<StoredMessage>): Promise<void>

// When job completes
await storageManager.updateMessage(chatId, assistantMsgId, {
  toolResults: [...existingResults, newJobResult],
  sequence: [...existingSequence, jobCompletionChunk],
});
```

## Testing Checklist

- [ ] Start agent task with long job
- [ ] Wait for agent stream to end (done chunk)
- [ ] Verify message saved to database
- [ ] Close app (Cmd+Q) while job running
- [ ] Reopen app
- [ ] Verify assistant message is present with tool calls
- [ ] Verify message doesn't appear "broken" or incomplete

## Impact

- **Before:** Message lost if app closes during job execution
- **After:** Message persisted when agent finishes, even if jobs still running
- **User Experience:** No lost conversations, seamless resume on reopen

## Related Issues

- Jobs running in background without UI indication (Issue 48)
- Message persistence during context compression (already handled)
- Gateway shutdown during active operations
