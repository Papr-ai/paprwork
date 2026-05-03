# Parallel Tool Execution - Race Conditions & Detection

## Overview

The agent executes multiple tool calls **in parallel** using `Promise.all()`. This improves performance but can cause race conditions and confusion.

## How Parallel Execution Works

```typescript
// From PiCodexStreamWithToolLoop.ts:522-526
const toolResults = await Promise.all(
  toolCallsThisTurn.map((tc, i) =>
    executeToolCall(tc, mastraTools, apiKeys, i === lastIdx),
  ),
);
```

When the AI model returns multiple tool calls in a single response, they **all start at the same time**.

## Potential Issues

### 1. File Write Conflicts

**Problem:** Multiple bash commands modifying the same file simultaneously.

**Example:**
```
Running: echo 'A' >> file.txt
Running: echo 'B' >> file.txt  
Running: sed -i 's/A/C/' file.txt
```

**Result:** Unpredictable file contents, data corruption, or errors.

**Detection:**
- File contents don't match expectations
- Bash commands fail with "file in use" errors
- Inconsistent results across runs

### 2. Working Directory State

**Problem:** Each bash command runs in an independent process. The working directory does NOT persist between calls.

**Example:**
```
bash: "cd ~/project"         # Changes dir in one process
bash: "npm install"          # Runs in original dir (not ~/project!)
```

**Why It Fails:** The first `cd` command exits, and its directory change is lost.

**Solution:** Use the `cwd` parameter instead:
```
bash: { command: "npm install", cwd: "~/project" }
```

**Detection:**
- Commands fail with "file not found"
- Multiple "Navigating to..." calls in UI
- Agent repeats `cd` commands unnecessarily

### 3. State-Dependent Operations

**Problem:** Command B depends on side effects from Command A, but they run simultaneously.

**Example:**
```
Running: mkdir newdir
Running: touch newdir/file.txt  # May fail if mkdir hasn't finished
```

**Detection:**
- Intermittent failures ("directory doesn't exist")
- Commands work when run sequentially but fail in parallel
- Race condition symptoms (works 80% of the time)

### 4. Tool Result Tracking

**Problem:** Each tool has a unique `toolCallId`. If results get mixed up or lost, the UI shows wrong status.

**Detection:**
- Tools stuck in "Running:" state forever
- Results appearing under wrong tool call
- UI showing checkmark but terminal shows error

## Detection Methods

### Method 1: Terminal Output Inspection

Check the running terminal for warnings:

```bash
# View terminal 3 (from screenshot)
tail -100 ~/.cursor/projects/Users-amirkabbara-Documents-GitHub-paprwork-v2/terminals/3.txt

# Look for specific issues
grep "⚠️\|🛑\|LOOP\|timeout\|crash" ~/.cursor/projects/*/terminals/3.txt
```

### Method 2: Tool Call Logs

The system logs detailed information about tool execution:

```bash
# Check for tools returning null/undefined
grep "returned null\|returned undefined" logs/*.log

# Check for tool timeouts
grep "timeout exceeded\|SIGKILL" logs/*.log

# Check for loop detection
grep "LOOP DETECTED" logs/*.log

# Check total tool call counts
grep "total tool calls:" logs/*.log | tail -20
```

### Method 3: UI Status Monitoring

Watch for these UI symptoms:

1. **Multiple "Running:" without checkmarks**
   - Normal if tasks take time
   - Problem if stuck for >60 seconds (bash timeout)

2. **Repeated "Navigating to..." calls**
   - Indicates agent doesn't understand `cd` doesn't persist
   - Agent should use `cwd` parameter instead

3. **Tool shows success but result is wrong**
   - Possible race condition on shared resource
   - Check if multiple tools touched same file

### Method 4: Code-Level Detection

The tool executor has built-in detection (PiCodexStreamWithToolLoop.ts):

```typescript
// Detects null/undefined results (line 94-106)
if (rawResult === undefined || rawResult === null) {
  console.warn(`⚠️ Tool returned null/undefined - possible timeout or crash`);
  return { 
    toolCallId: toolCall.toolCallId,
    result: { 
      success: false,
      error: `Tool returned no result (possible timeout or crash)`,
    },
  };
}

// Detects empty results (line 228)
if (!text || text.length === 0) {
  text = `[Tool ${tr.toolName} returned empty result - possible timeout or crash]`;
}
```

### Method 5: Bash-Specific Detection

The bash tool (bash.ts) logs important events:

```typescript
// Timeout detection (line 542-563)
if (execError.killed || execError.signal === "SIGTERM" || execError.signal === "SIGKILL") {
  return {
    success: false,
    error: `Command timed out after ${timeout}ms`,
    type: "timeout_error",
  };
}

// Process crash detection (line 462-476)
if (stdout === undefined && stderr === undefined) {
  console.warn('⚠️ Command returned undefined output - possible process crash');
  return {
    success: false,
    error: 'Command returned no output (possible timeout or process failure)',
  };
}
```

## When Parallel Execution is Safe

✅ **Safe scenarios:**
- Reading different files
- Independent bash commands (git status, ls, pwd)
- Commands with explicit `cwd` set to different directories
- Read-only operations

❌ **Unsafe scenarios:**
- Writing to the same file
- State-dependent commands (mkdir then cd)
- Commands expecting persistent environment changes
- Operations on shared resources without locking

## Solutions & Mitigations

### Solution 1: Sequential Tool Calls (NOT IMPLEMENTED)

Currently, ALL tool calls in a turn run in parallel. Could be modified to:

```typescript
// Option A: Always sequential
for (const tc of toolCallsThisTurn) {
  const result = await executeToolCall(tc, mastraTools, apiKeys, false);
  yield { type: "tool-result", ...result };
}

// Option B: Detect conflicts and serialize
const hasFileConflict = detectFileConflicts(toolCallsThisTurn);
if (hasFileConflict) {
  // Run sequentially
} else {
  // Run in parallel
}
```

**Trade-off:** Sequential execution is slower but safer.

### Solution 2: Agent Awareness

Update system prompt to warn agent about parallel execution:

```
⚠️ IMPORTANT: When you make multiple tool calls in one response, they execute IN PARALLEL.

DO NOT:
- Use 'cd' commands - use 'cwd' parameter instead
- Make multiple calls that modify the same file
- Chain dependent operations without proper sequencing

DO:
- Use cwd parameter: bash({ command: "npm install", cwd: "~/project" })
- Break dependent operations into separate turns
- Use && for sequential commands within one bash call
```

### Solution 3: Working Directory Tracking

Track working directory state and auto-inject `cwd`:

```typescript
// Track last directory change
let currentWorkingDir = process.cwd();

// Auto-inject cwd into bash commands
if (toolCall.toolName === "bash" && !toolCall.args.cwd) {
  toolCall.args.cwd = currentWorkingDir;
}

// Update on cd commands (parse bash for cd)
if (command.includes("cd ")) {
  currentWorkingDir = parseDirectoryFromCd(command);
}
```

### Solution 4: Add Tool Dependencies

Allow agent to specify tool execution order:

```typescript
// Hypothetical API
toolCalls = [
  { id: "1", name: "bash", args: { command: "mkdir dir" } },
  { id: "2", name: "bash", args: { command: "touch dir/file.txt" }, dependsOn: ["1"] },
];
```

This would require changes to the tool call format and executor.

## Quick Diagnostic Checklist

When you see suspicious parallel tool behavior:

- [ ] Check terminal output for warnings (`grep "⚠️" terminals/*.txt`)
- [ ] Look for tool calls stuck >60 seconds in "Running:" state
- [ ] Count "Navigating to..." calls - more than 2-3 suggests confusion
- [ ] Check if multiple tools touched the same file path
- [ ] Verify bash commands use `cwd` parameter instead of `cd`
- [ ] Look for loop detection warnings in logs
- [ ] Check if tool results have mismatched `toolCallId`s

## Example: Your Screenshot Analysis

From your screenshot:

```
✅ Ran: cd ~/Documents/GitHub/memory # 1. Get th...
🔄 Running: cd ~/Documents/GitHub/memory # Better ap...
🔄 Running: cd ~/Documents/GitHub/memory # Get all m...
🔄 Running: cd ~/Documents/GitHub/memory # Now check...
🔄 Navigating to .../Documents/GitHub/memory
🔄 Navigating to .../Documents/GitHub/memory
🔄 Navigating to .../Documents/GitHub/memory
🔄 Navigating to .../Documents/GitHub/memory
🔄 Running: cd ~/Documents/GitHub/memory # Look for ...
🔄 Running: cd ~/Documents/GitHub/memory # Find appl...
🔄 Running: cd ~/Documents/GitHub/memory # OK so rer...
🔄 Running: cd ~/Documents/GitHub/memory # Get the r...
🔄 Running: cd ~/Documents/GitHub/memory # Get what ...
🔄 Navigating to .../Documents/GitHub/memory (3 more)
```

**Diagnosis:**
1. Agent is making 13+ tool calls simultaneously
2. Multiple `cd` commands (doesn't persist between calls)
3. Multiple "Navigating" operations (likely redundant)
4. Only 1 checkmark = only 1 completed so far

**Root Cause:**
- Agent doesn't understand `cd` doesn't work in parallel
- Making many redundant navigation attempts
- Possible loop (same command repeated 5+ times)

**Expected Behavior:**
- Should use `cwd` parameter once
- Should avoid redundant navigation
- Loop detection should trigger warning

**Action:**
Check if loop detection triggered:
```bash
grep "LOOP DETECTED" ~/.cursor/projects/*/terminals/3.txt
```

Check tool call count:
```bash
grep "total tool calls:" ~/.cursor/projects/*/terminals/3.txt | tail -5
```
