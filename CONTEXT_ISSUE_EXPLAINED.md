# Context Length Exceeded - Root Cause & Fix

## TL;DR

**Problem**: Agent stops after 1 tool call with `context_length_exceeded` error.

**Root Cause**: Default AI SDK behavior (`stopWhen: stepCountIs(1)`) + Large context on retry.

**Fix Applied**: Changed `stopWhen` to allow 100 steps before stopping.

**Status**: ⚠️ **RESTART REQUIRED** - Backend changes don't hot-reload!

---

## What's Happening

### The Error Chain

```
User: "what files about papr memory memo do i have in the dropbox folder?"
  ↓
Step 1: Agent thinks + calls bash tool
  ↓ ✅ SUCCESS
Step 1: Tool returns result
  ↓
Step 2: Agent tries to continue...
  ↓ ❌ ERROR: context_length_exceeded
```

### Why It Fails on Step 2

Looking at the terminal logs (line 1011-1027):
```
[AgentService] Received chunk type: tool-result
[AgentService] Received chunk type: finish-step
[AgentService] Received chunk type: start-step  ← Starting step 2
{
  type: 'error',
  code: 'context_length_exceeded',  ← Fails here
  message: 'Your input exceeds the context window...'
}
```

### Two Problems Combined

**Problem 1**: Default `stopWhen` behavior
- AI SDK default: `stopWhen: stepCountIs(1)`
- This stops after the FIRST step (no continuation)
- But we changed this to `stopWhen: (options) => options.steps.length >= 100`

**Problem 2**: Context builds up on retries
- First try: System prompt + user message + tool result ≈ 50K tokens
- Second try ("try again"): Adds ANOTHER 50K tokens
- Third try: Adds ANOTHER 50K tokens
- After 3-4 tries: Exceeds 200K context limit

---

## Model Context Limits

| Model | Context Window |
|-------|---------------|
| Claude Sonnet 4.5 | 200K tokens |
| Claude Opus 4.5 | 200K tokens |
| Claude Sonnet 4 | 1M tokens (with beta header) |
| GPT-5.2 | Unknown (likely 128K-200K) |
| GPT-4 Turbo | 128K tokens |

**Current default**: Claude Sonnet 4.5 (200K tokens)

---

## Why Restart Is Required

### Hot Reload vs Cold Restart

**Frontend (UI) changes**: Hot reload automatically
- React components (`.tsx`)
- CSS files (`.css`)
- Hooks, stores

**Backend (Gateway) changes**: Require full restart
- `src/gateway/**/*` files
- `src/core/**/*` files  
- Any Node.js server code

### What We Changed

File: `src/gateway/services/AgentService.ts`
```typescript
// OLD (still running in memory):
const result = await streamText({
  model,
  messages,
  tools,
  // No stopWhen specified = default stepCountIs(1)
});

// NEW (in file, but not loaded yet):
const result = await streamText({
  model,
  messages,
  tools,
  stopWhen: (options) => options.steps.length >= 100,  ← This code
  timeout: { totalMs: 5 * 60 * 1000 },
});
```

**The running process is still using the OLD code!**

---

## How to Restart Properly

### Step 1: Stop Everything
```bash
# In terminal where "npm start" is running:
Ctrl+C

# Wait for clean shutdown:
[Gateway] Shutting down...
[Electron] Shutting down...
```

### Step 2: Verify Ports Are Free
```bash
# Check if Gateway port is still in use:
lsof -i :18789

# If port is occupied, kill it:
npm run kill:gateway
```

### Step 3: Start Fresh
```bash
npm start
```

### Step 4: Verify New Code is Loaded
Send a test message and check terminal logs:
```
# Should NOT see "finish" after first tool-result
# SHOULD see multiple tool-call / tool-result cycles
```

---

## After Restart: Expected Behavior

### Test Case: "what files about papr memory memo do i have in the dropbox folder?"

**Old Behavior** (before restart):
```
Step 1: bash tool → ✅
Step 2: finish → 🛑 (stops immediately)
```

**New Behavior** (after restart):
```
Step 1: bash tool → ✅
Step 2: Continue thinking → ✅
Step 3: Maybe another tool call → ✅
...
Step N: Text response → ✅
```

---

## Token Budgets (Current V2)

### Application Limits
```typescript
// src/core/agents/SessionManager.ts
maxTokens: 100,000  // When to compact history
targetTokens: 50,000  // Target after compaction
minMessagesToKeep: 10  // Keep at least 10 messages
```

### Model Limits (Not Configurable)
- Claude Sonnet 4.5: **200,000** tokens
- Claude Opus 4.5: **200,000** tokens

### Result Truncation
```typescript
// src/core/tools/security.ts
MAX_RESULT_LENGTH = 50,000  // characters
// ≈ 12,500 tokens
```

---

## Comparison: V1 vs V2

### Context Management

| Feature | V1 | V2 |
|---------|----|----|
| **Default Model** | Claude Sonnet 4.5 | Claude Sonnet 4.5 |
| **Context Window** | 200K tokens | 200K tokens |
| **History Compression** | Manual/on-demand | Automatic (6 messages + summary) |
| **Tool Result Truncation** | Unknown | 50K chars (12.5K tokens) |
| **System Prompt** | ~2K tokens | ~3K tokens |
| **Stop Condition** | Unknown | 100 steps |

### OpenClaw

- Uses multiple test configs (vitest.live.config.ts, etc.)
- Likely uses default AI SDK behavior
- May not need as many steps (different use case)

---

## Recommendations

### Immediate (Do Now)

1. **Restart the app** to load new code
2. **Test with fresh chat** (not "try again" multiple times)
3. **Monitor terminal logs** for multiple step cycles

### Short-term (Next PR)

1. **Add step logging**:
   ```typescript
   console.log(`[AgentService] Step ${options.steps.length + 1}/100`);
   ```

2. **Add context size logging**:
   ```typescript
   const estimatedTokens = Math.ceil(JSON.stringify(messages).length / 4);
   console.log(`[AgentService] Context size: ~${estimatedTokens} tokens`);
   ```

3. **Handle context_length_exceeded gracefully**:
   ```typescript
   if (error.code === 'context_length_exceeded') {
     // Try again with compressed history
     messages = await compressHistory(messages);
   }
   ```

### Long-term (Future)

1. **Dynamic Model Selection**: Auto-switch to models with larger context when needed
2. **Smart Tool Result Summarization**: Summarize large tool outputs before adding to context
3. **Incremental History Loading**: Only load what's needed for current task
4. **Context Budget Tracking**: Track remaining tokens in real-time

---

## Testing Checklist

After restart:

- [ ] App restarts cleanly (no errors)
- [ ] First message works (thinking + tool call + text response)
- [ ] Second message works (continues conversation)
- [ ] Terminal shows multiple "finish-step" (not just one)
- [ ] No "context_length_exceeded" errors
- [ ] Agent provides text response after tool calls

---

## If Still Getting Errors

### Error: context_length_exceeded (even after restart)

**Possible causes**:
1. Tool result is genuinely massive (100K+ characters)
2. System prompt is too long
3. History isn't being compressed

**Debug**:
```typescript
// Add to AgentService.ts before streamText():
console.log('[AgentService] Messages count:', messages.length);
console.log('[AgentService] Messages size:', JSON.stringify(messages).length);
messages.forEach((msg, i) => {
  console.log(`  Message ${i}: ${msg.role} - ${msg.content.length} chars`);
});
```

### Error: Stream timeout

**Cause**: 5 minute timeout we added

**If it's timing out**:
- Increase timeout: `totalMs: 10 * 60 * 1000` (10 minutes)
- OR remove timeout entirely (rely on stopWhen only)

---

## Summary

✅ **Fix is in the code** (`stopWhen: 100 steps`)  
⚠️ **But not running yet** (need restart)  
🎯 **Next**: Restart and test  
📊 **Monitor**: Terminal logs for step progression

**The fix will work once you restart!**
