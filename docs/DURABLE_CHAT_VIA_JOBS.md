# Sleep/Wake Solution: Use Existing Job Infrastructure

**Status:** Better Approach Than Checkpoint Proposal
**Complexity:** Low (reuse existing code)
**Estimated Effort:** 2-3 days (vs 2-3 weeks)

## Key Insight

We already have a durable, retryable agent execution system: **Agent Jobs**. 

Instead of building a new checkpoint/resume system from scratch, we should **convert streaming chat sessions into background agent jobs** when they risk interruption.

## Current Problem

```
User Chat Session:
┌─────────────────────────────────────────┐
│ User sends message                       │
│    ↓                                     │
│ AgentService.streamResponse()            │
│    ↓                                     │
│ WebSocket.send(chunk)  ← FRAGILE        │
│    ↓                                     │
│ Laptop sleeps → CONNECTION LOST ✗        │
│    ↓                                     │
│ No recovery, user must re-send          │
└─────────────────────────────────────────┘
```

## Proposed Solution

```
User Chat Session (Durable Mode):
┌─────────────────────────────────────────┐
│ User sends message                       │
│    ↓                                     │
│ Detect: Long-running request?            │
│    ↓                                     │
│ YES → Convert to Agent Job               │
│    ↓                                     │
│ JobsService.createJob({                  │
│   type: "agent",                         │
│   command: userMessage,                  │
│   deliver: { channel: "chat", chatId }, │
│   reportChatId: chatId                   │
│ })                                       │
│    ↓                                     │
│ AgentJobExecutor.launch() ← DURABLE      │
│    ↓                                     │
│ runIsolatedJobSession()                  │
│   - Saves full conversation to DB        │
│   - Retries on network failure           │
│   - Survives laptop sleep               │
│    ↓                                     │
│ Job completes → delivers to chat         │
│    ↓                                     │
│ UI shows response ✓                      │
└─────────────────────────────────────────┘
```

## Implementation

### Step 1: Detect Long-Running Requests

Add heuristic to detect when to use durable mode:

```typescript
// src/gateway/websocket/agent.ts
case "agent:stream": {
  const { chatId, message: userMessage, config } = payload;
  
  // Heuristic: Use durable mode for:
  // 1. Messages longer than 500 chars (complex tasks)
  // 2. Messages with keywords: "research", "analyze", "write", "create"
  // 3. User explicitly requests: "background job"
  // 4. Model is expensive: GPT-5.4, Claude Opus
  
  const isDurableRequest = 
    userMessage.length > 500 ||
    /\b(research|analyze|write|create|generate|build)\b/i.test(userMessage) ||
    /background|durable|job/i.test(userMessage) ||
    config.model?.includes('gpt-5.4') ||
    config.model?.includes('opus');
  
  if (isDurableRequest) {
    // Convert to agent job instead of streaming
    await convertToAgentJob(chatId, userMessage, config);
    sendResponse(ws, message.id, { 
      mode: 'durable', 
      message: 'Running in background (survives laptop sleep)' 
    });
    return;
  }
  
  // Otherwise, use normal streaming
  // ... existing code ...
}
```

### Step 2: Convert Chat Request to Agent Job

```typescript
// src/gateway/utils/durableChat.ts
export async function convertToAgentJob(
  chatId: string,
  userMessage: string,
  config: AgentConfig
): Promise<string> {
  const jobsService = getJobsService();
  
  // Create agent job that will deliver result back to chat
  const jobId = await jobsService.createJob({
    name: `Chat Response: ${userMessage.substring(0, 50)}...`,
    type: "agent",
    command: userMessage,
    deliver: {
      channel: "chat",
      targetId: chatId  // ← Delivers back to original chat!
    },
    reportChatId: chatId,  // ← Tool calls visible in chat UI
    provider: config.provider,
    model: config.model,
    retries: {
      maxAttempts: 3,  // ← Automatic retries on failure!
      backoffMs: 5000
    },
    memoryPolicy: "full",  // ← Save to memory
    folder: "chat-responses"
  });
  
  // Run the job immediately (non-blocking)
  await jobsService.runJob(jobId, { wait: false });
  
  return jobId;
}
```

### Step 3: Show Job Progress in Chat UI

The job system already broadcasts updates via WebSocket:

```typescript
// Jobs already send these events:
broadcast({ type: "jobs:updated", data: { jobId, status: "running" } });
broadcast({ type: "subagent-job-started", data: { jobId, reportChatId } });
broadcast({ type: "chat:message-received", data: { chatId, message } });
```

We just need to render them in the chat UI:

```typescript
// ui/components/Chat/MessageCard.tsx
{message.fromJob && (
  <div className="job-indicator">
    <Icon name="background-task" />
    Running in background (survives sleep)
    <JobProgress jobId={message.fromJob} />
  </div>
)}
```

### Step 4: User Control

Add UI option for users to choose mode:

```typescript
// Settings → Advanced
durableChatMode: "auto" | "always" | "never"

// Chat input UI
<Button onClick={() => setDurableMode(!durableMode)}>
  {durableMode ? "🛡️ Durable" : "⚡ Fast"}
</Button>
```

## What This Gives Us

### Already Implemented (Jobs System)
- ✅ **Retry logic** - 3 attempts with exponential backoff
- ✅ **Error classification** - Transient vs permanent errors
- ✅ **Run history** - Every run saved to JSONL
- ✅ **Chat delivery** - `deliver.channel = "chat"` sends result to chat
- ✅ **Tool visibility** - `reportChatId` makes tool calls visible in chat
- ✅ **Memory integration** - `memoryPolicy` saves to Papr Memory
- ✅ **Execution tracking** - `currentAttempt`, `lastExecutionId`
- ✅ **Durable storage** - Full conversation saved in isolated session DB

### What We Need to Add (Minimal)
- [ ] Heuristic to detect long-running requests
- [ ] `convertToAgentJob()` helper function
- [ ] Job progress indicator in chat UI
- [ ] User setting for durable mode preference

**Estimated effort:** 2-3 days (vs 2-3 weeks for checkpoint system)

## Benefits Over Checkpoint Proposal

### Simpler
- ❌ Checkpoint: New service, new DB schema, new WebSocket handlers
- ✅ Jobs: Reuse existing infrastructure

### More Reliable
- ❌ Checkpoint: Untested, complex state machine
- ✅ Jobs: Already tested with E2E test suite

### More Features
- ❌ Checkpoint: Only handles resume
- ✅ Jobs: Retry, error classification, run history, memory integration

### Lower Risk
- ❌ Checkpoint: 2-3 weeks, high complexity
- ✅ Jobs: 2-3 days, proven patterns

## When to Use Each Mode

### Fast Mode (Current Streaming)
- Short messages (<500 chars)
- Simple questions
- Immediate responses
- No tooling
- User is at computer

### Durable Mode (Agent Jobs)
- Long messages (>500 chars)
- Complex tasks (research, analysis, writing)
- Tool-heavy workflows
- Laptop might sleep
- Background processing

## User Experience

### Before (Current)
```
User: "Research AI regulations and write a 5000-word report"
[Laptop sleeps after 10 minutes]
[Wake up] ❌ Response lost, must re-send
```

### After (With Durable Mode)
```
User: "Research AI regulations and write a 5000-word report"
Agent: "🛡️ Running in background (survives sleep)"
[Shows job progress: "Step 2 of 5: Analyzing EU AI Act..."]
[Laptop sleeps for 2 hours]
[Wake up] ✅ Report completed and delivered to chat!
```

## Implementation Priority

**Phase 1 (2-3 days):**
- [ ] Add `convertToAgentJob()` helper
- [ ] Detect long-running requests
- [ ] Show "Running in background" message
- [ ] Test: Sleep during job → Resume works

**Phase 2 (1 week):**
- [ ] Job progress indicator in chat UI
- [ ] User setting for mode preference
- [ ] Documentation & user guide

**Phase 3 (Future):**
- [ ] Auto-detect expensive operations
- [ ] Predictive durability (ML-based)
- [ ] Cloud sync (run job on server)

## Comparison: This vs Checkpoint Proposal

| Feature | Checkpoint Proposal | Jobs Approach |
|---------|-------------------|---------------|
| **Complexity** | High (new system) | Low (reuse existing) |
| **Effort** | 2-3 weeks | 2-3 days |
| **Reliability** | Untested | Proven (E2E tested) |
| **Retries** | Manual implementation | Built-in |
| **Error Handling** | Manual implementation | Built-in |
| **Run History** | Manual implementation | Built-in |
| **Memory Integration** | Manual implementation | Built-in |
| **Storage** | New checkpoint DB | Existing job DB |
| **UI Integration** | New progress system | Existing job UI |
| **Risk** | High (greenfield) | Low (incremental) |

## Conclusion

**We already built Temporal-lite for jobs. Let's use it for chat too!**

Instead of creating a parallel checkpoint system, we should:
1. Detect long-running chat requests
2. Convert them to agent jobs
3. Let the existing durable job system handle them

**Recommendation:** Implement jobs approach (2-3 days) instead of checkpoint proposal (2-3 weeks).

**Priority:** P1 High - Much simpler than checkpoint proposal, reuses proven infrastructure.
