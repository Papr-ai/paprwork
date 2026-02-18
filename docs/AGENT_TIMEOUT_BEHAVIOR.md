# Agent Timeout Behavior

## Overview

Paprwork V2 is designed to support **long-running agentic workflows** without artificial time limits. Agents can work as long as needed to complete their task.

## Timeout Configuration

### ⚡ Backend: NO TIMEOUT (Step-Limited)

**File**: `src/gateway/services/AgentService.ts`

```typescript
const result = await streamText({
  model,
  messages,
  tools,
  stopWhen: (stopOptions) =>
    stopOptions.steps.length >= (options?.maxSteps ?? 100),
  // ⚡ NO TIMEOUT - Agents can work as long as needed
  abortSignal: abortController.signal, // User can abort
});
```

**Protection Mechanisms:**
1. ✅ **Step Limit**: Max 100 tool calls (prevents infinite loops)
2. ✅ **Abort Controller**: User can cancel anytime via UI
3. ✅ **Progress Tracking**: UI shows agent activity
4. ✅ **Cost Tracking**: Monitor token usage

### ⚡ Frontend: NO TIMEOUT (Trust Backend Protection)

**File**: `ui/src/lib/gateway.ts`

```typescript
// ⚡ NO TIMEOUT - Trust backend protection mechanisms:
// 1. Step limit (100 tool calls) prevents infinite loops
// 2. User can abort via UI anytime
// 3. Backend monitors progress and can warn if needed
// Let agents work as long as they need to complete their task!
```

**Why no frontend timeout?**
- Step limit already prevents infinite loops
- User has abort button for manual control
- No need for arbitrary time-based cutoff
- Agents can truly work until task completion

---

## Why No Backend Timeout?

### ❌ Problems with Hard Timeouts

**Old System (5-minute timeout):**
```
User: "Refactor the entire codebase to use TypeScript"

Agent:
  ✅ Analyzing codebase (1 min)
  ✅ Planning refactor (30s)
  ✅ Converting 20 files (3 min)
  ✅ Running tests (2 min)
  ❌ TIMEOUT! - Legitimate work killed at 7 minutes
```

**New System (no backend timeout):**
```
User: "Refactor the entire codebase to use TypeScript"

Agent:
  ✅ Analyzing codebase (1 min)
  ✅ Planning refactor (30s)
  ✅ Converting 20 files (3 min)
  ✅ Running tests (2 min)
  ✅ Fixing test failures (3 min)
  ✅ Updating documentation (1 min)
  ✅ COMPLETE! - 10.5 minutes, task finished
```

---

## Protection Against Infinite Loops

### 1. Step Limit (Primary Protection)

**Default**: 100 tool calls per request

```typescript
interface StreamOptions {
  maxSteps?: number; // Default: 100
}

// Example: Increase for very complex tasks
streamAgent(chatId, message, config, {
  maxSteps: 200 // Allow more steps
});
```

**Why 100 steps?**
- Most tasks complete in 5-20 steps
- Complex tasks may need 50-80 steps
- 100 provides headroom for edge cases
- Prevents actual infinite loops (same tool called 1000x)

**Example scenarios:**

| Task | Typical Steps | Within Limit? |
|------|---------------|---------------|
| Simple Q&A | 0-2 | ✅ Yes |
| Code generation | 5-15 | ✅ Yes |
| Multi-file refactor | 20-50 | ✅ Yes |
| Complex research | 30-80 | ✅ Yes |
| Full app scaffold | 50-90 | ✅ Yes |
| Infinite loop (bug) | 1000+ | ❌ No - Stopped at 100 |

### 2. User Abort (Secondary Protection)

Users can cancel anytime:

```typescript
// Stop button in UI triggers:
await gateway.send("agent:stop", { chatId });

// This aborts the stream immediately via AbortController
abortController.abort();
```

### 3. Progress Visibility (User Awareness)

**Users always see what the agent is doing:**

```
Agent Message (Streaming):
  🔧 bash: Analyzing project structure... ✓
  🔧 filesystem: Reading package.json... ✓
  🔧 bash: Running tests... ⏳ (in progress)
  💭 Thinking: Based on test results, I need to...
```

**If agent seems stuck, user can:**
- Click "Stop" button
- Review progress
- Try again with clearer instructions

---

## Legitimate Long-Running Scenarios

These workflows should NOT timeout:

### 1. Code Refactoring (5-15 minutes)
```
1. Analyze codebase structure (1 min)
2. Plan refactoring strategy (30s)
3. Modify 50 files (5 min)
4. Run test suite (3 min)
5. Fix failing tests (4 min)
6. Update documentation (1 min)
Total: 14.5 minutes ✅
```

### 2. Research & Report Generation (10-20 minutes)
```
1. Web search for sources (2 min)
2. Read 20 articles (5 min)
3. Analyze data (3 min)
4. Write comprehensive report (7 min)
5. Create visualizations (2 min)
6. Export to PDF (1 min)
Total: 20 minutes ✅
```

### 3. Data Processing Job (5-30 minutes)
```
1. Fetch data from API (2 min)
2. Process 10,000 records (15 min)
3. Generate reports (5 min)
4. Upload results (3 min)
5. Send notifications (1 min)
Total: 26 minutes ✅
```

### 4. Infrastructure Setup (15-30 minutes)
```
1. Create project structure (2 min)
2. Configure CI/CD (5 min)
3. Set up database (3 min)
4. Deploy to staging (10 min)
5. Run smoke tests (5 min)
6. Update documentation (3 min)
Total: 28 minutes ✅
```

---

## When Would a Stream Stop?

### 1. Natural Completion (Most Common)
```
Agent finishes task → Stream ends → User sees final response
```

### 2. Step Limit Reached (Safety)
```
Agent makes 100 tool calls → Stop → Show progress to user
```

**User sees:**
```
⚠️ Agent reached maximum steps (100 tool calls)

Progress so far:
  ✅ Analyzed 50 files
  ✅ Modified 30 files
  ⏸️  Stopped before modifying remaining 20 files

You can:
  1. Review the work done so far
  2. Continue with a new message: "Continue the refactoring"
  3. Adjust your request to be more specific
```

### 3. User Abort (User Choice)
```
User clicks "Stop" → Abort signal → Stream ends immediately
```

### 4. Connection Loss (Network Issue)
```
WebSocket disconnects → Stream ends → User sees connection error
```

**User sees:**
```
⚠️ Connection lost

The agent's work was interrupted due to a network issue.

Try:
  1. Check your internet connection
  2. Refresh the page
  3. Send your message again
```

---

## Configuring Limits

### Per-Request Step Limit

```typescript
// In UI or custom tool
const response = await gateway.stream(
  "agent:stream",
  {
    chatId,
    message,
    config,
    options: {
      maxSteps: 200, // Allow 200 tool calls for complex task
    }
  },
  onChunk
);
```

### Job Automation Override

**File**: `src/gateway/services/AgentService.ts:runIsolatedJobSession()`

```typescript
async runIsolatedJobSession(input: {
  jobId: string;
  runId: string;
  prompt: string;
  maxTurns?: number; // Custom limit for jobs
}) {
  // Jobs can specify their own limits
  for await (const chunk of this.streamAgent(chatId, input.prompt, config, {
    allowedToolIds: input.allowedToolIds,
    maxSteps: input.maxTurns ?? 100, // Use job-specific limit
  })) {
    // Process chunks
  }
}
```

---

## Monitoring Long-Running Agents

### Console Logs

**Setup phase:**
```
[AgentService] 📊 Context Analysis:
  History: 15 messages, ~8,500 tokens
  Total context: ~16,500 tokens
[AgentService] ⏱️ Setup: 94.38ms
```

**Progress updates:**
```
[AgentService] Tool call: bash { command: 'npm test' }
[AgentService] Tool result: Tests passed (15/15)
[AgentService] Tool call: filesystem { path: 'src/app.ts', action: 'write' }
```

**Completion:**
```
[AgentService] Stream complete
  Tool calls: 47
  Duration: 8.3 minutes
  Final token count: 42,500
```

### Future: Progress Dashboard

```
Agent Working... (3m 24s)
────────────────────────────────────────
Tool Calls: 23/100 steps
Latest: Running tests (15s)
Token Usage: 12,450 / ~50,000 estimated
────────────────────────────────────────
[Stop Agent]
```

---

## Error Handling

### If Agent Gets Stuck

**Symptoms:**
- Same tool called repeatedly with same args
- No progress for >2 minutes
- Token usage growing but no output

**Detection:**
```typescript
// Future: Add loop detection
const toolCallHistory = new Map<string, number>();

for (const toolCall of toolCalls) {
  const key = `${toolCall.name}:${JSON.stringify(toolCall.args)}`;
  const count = (toolCallHistory.get(key) || 0) + 1;
  toolCallHistory.set(key, count);
  
  if (count > 5) {
    // Same tool called 5+ times with same args
    yield {
      type: "warning",
      payload: {
        message: "Agent may be stuck in a loop",
        toolName: toolCall.name,
        count,
      }
    };
  }
}
```

---

## Best Practices

### For Users

✅ **DO:**
- Let agents complete complex tasks
- Review progress as it streams
- Use "Stop" if agent seems stuck
- Break very large tasks into phases

❌ **DON'T:**
- Panic if agent takes >5 minutes
- Abort too early on complex tasks
- Request impossible tasks (agent will hit step limit)

### For Developers

✅ **DO:**
- Monitor step counts in production
- Log when agents approach step limit
- Alert if >80 steps used frequently
- Provide progress indicators

❌ **DON'T:**
- Add arbitrary time limits
- Kill streams based on duration alone
- Assume all tasks are quick

---

## Comparison: Old vs New

| Aspect | Old (5min timeout) | New (No timeout) |
|--------|-------------------|------------------|
| **Simple tasks** | ✅ Complete fine | ✅ Complete fine |
| **Complex refactoring** | ❌ Times out | ✅ Completes |
| **Research tasks** | ❌ Times out | ✅ Completes |
| **Data processing** | ❌ Times out | ✅ Completes |
| **Multi-hour workflows** | ❌ Times out | ✅ Completes |
| **Infinite loop protection** | ❌ Time-based (5min) | ✅ Step-based (100 calls) |
| **User control** | ❌ Hard kill only | ✅ Graceful abort anytime |
| **Cost protection** | ❌ None | ✅ Step limit + monitoring |
| **Frontend timeout** | ❌ 5 minutes | ✅ None needed |

---

## Summary

**Philosophy**: Trust the agent to complete its work. Step limits provide safety without artificial time constraints.

**Key Changes**:
1. ✅ **Removed 5-minute backend timeout**
2. ✅ **Removed 30-minute frontend timeout**
3. ✅ **Keep 100-step limit** (prevents infinite loops)
4. ✅ **User can abort anytime** (always in control)

**Result**: Agents can complete legitimate long-running tasks without any time limits, while still protected against infinite loops and runaway costs through step-based limits.

🎯 **The system is now truly agentic** - agents work as long as needed to complete their task, bounded only by work complexity (steps), not arbitrary time!
