# Testing Guide: Adaptive Context Management

## ✅ App is Running

The app has been started and is ready for testing. A test file has been created at `/tmp/test-large-file.js` (14.5KB, 725 lines, ~3700 tokens).

## Test Cases

### Test 1: Graceful Error Handling 🎯

**What to test:**
```
Ask the agent: "Read /tmp/test-large-file.js"
```

**Expected Behavior:**
1. ✅ Tool returns error (NOT hard failure)
2. ✅ Error message shows:
   - File size: "~3700 tokens (~14KB, 725 lines)"
   - 4 specific alternatives with exact commands
3. ✅ Agent reads the error and retries with:
   ```
   read_file({ path: "/tmp/test-large-file.js", offset: 1, limit: 100 })
   ```
4. ✅ Second attempt succeeds
5. ✅ UI never breaks
6. ✅ Agent shows you the first 100 lines

**What to watch in terminal:**
```
Tool execution error (graceful):
"File 'test-large-file.js' is 3714 tokens (~14KB, 725 lines).

This exceeds context limits and will be heavily truncated...

✅ Better approaches:
1. Read incrementally: read_file({ path: "...", offset: 1, limit: 100 })
..."
```

---

### Test 2: Adaptive Truncation 📊

**What to test:**
```
Ask the agent: "Read src/gateway/services/AgentService.ts"
```

**Expected Behavior:**
1. ✅ Agent gets size warning
2. ✅ Agent retries with offset/limit
3. ✅ Terminal shows pressure levels:
   ```
   [prepareStep] Step 5: 45K tokens used, pressure: low
   ```
4. ✅ Truncation adapts to pressure

**Watch terminal for adaptive limits:**
```bash
# At low pressure (<50K tokens):
[prepareStep] Step 3: 35K tokens used, pressure: low
[... truncated (limit: ~3000 tokens, context: 35K/low)]

# At medium pressure (50-100K):
[prepareStep] Step 8: 75K tokens used, pressure: medium
[... truncated (limit: ~2000 tokens, context: 75K/medium)]

# At high pressure (>100K):
[prepareStep] Step 12: 115K tokens used, pressure: high
[... truncated (limit: ~1000 tokens, context: 115K/high)]
```

---

### Test 3: Multiple Large Files 🔥

**What to test:**
```
Ask: "Read src/core/tools/filesystem.ts and src/gateway/services/AgentService.ts and src/core/agents/SystemPrompt.ts"
```

**Expected Behavior:**
1. ✅ All 3 files trigger size warnings
2. ✅ Agent uses offset/limit for all of them
3. ✅ Context pressure increases gradually
4. ✅ Limits tighten automatically
5. ✅ No "context_length_exceeded" errors
6. ✅ Conversation completes successfully

**Watch for progression:**
```
Step 1: Read file 1 with offset/limit
  → [prepareStep] 25K tokens, pressure: low

Step 3: Read file 2 with offset/limit
  → [prepareStep] 45K tokens, pressure: low → Still generous

Step 5: Read file 3 with offset/limit
  → [prepareStep] 65K tokens, pressure: medium → Tightening

Step 7: Continue working
  → [prepareStep] 85K tokens, pressure: medium → More aggressive

No errors! Context managed successfully ✅
```

---

## What Success Looks Like

### ✅ Feature 1: Graceful Errors
- [ ] Agent gets helpful error (not crash)
- [ ] Error shows exact file stats
- [ ] Error lists 4 alternatives
- [ ] Agent retries with better approach
- [ ] UI never breaks
- [ ] User sees useful result

### ✅ Feature 2: Adaptive Truncation
- [ ] Terminal shows pressure levels
- [ ] Low pressure → generous limits (12KB, 6KB, 3KB)
- [ ] Medium pressure → moderate limits (8KB, 4KB, 2KB)
- [ ] High pressure → aggressive limits (4KB, 2KB, 1KB)
- [ ] Last result always kept full
- [ ] Truncation messages show context state

---

## How to Monitor

### Watch Terminal Window 668841

```bash
# Method 1: Tail the terminal file
tail -f ~/.cursor/projects/YOUR_PROJECT_PATH/terminals/TERMINAL_ID.txt

# Method 2: Watch for specific patterns
grep -E "(prepareStep|pressure:|truncated)" /path/to/terminal.txt
```

### Look for These Logs

```bash
# Graceful error from tool
[Tool] File "test.js" is 5000 tokens. Better approaches: ...

# Adaptive truncation before each step
[prepareStep] Step 5: 45K tokens used, pressure: low
[prepareStep] Step 10: 85K tokens used, pressure: medium
[prepareStep] Step 15: 120K tokens used, pressure: high

# Truncation with context info
[... 8000 chars truncated (tool #2 from end, limit: ~2000 tokens, context: 85K/medium)]
```

---

## Quick Start

1. **Open the app** (already running)
2. **Start a new chat**
3. **Try Test 1**: "Read /tmp/test-large-file.js"
4. **Watch terminal**: Look for error message with alternatives
5. **Verify agent retries**: Should use offset/limit
6. **Try Test 3**: Ask to read multiple large source files
7. **Watch pressure levels**: Should see low → medium → high
8. **Verify no crashes**: Context should stay under 150K

---

## Troubleshooting

### If you don't see pressure logs:
- Check you're watching the right terminal (668841)
- Verify agent is actually making tool calls
- Look for `[prepareStep]` in logs

### If agent doesn't retry after error:
- Check the error message is formatted correctly
- Verify agent can see tool errors (not just exceptions)
- Look at the tool result in terminal

### If context still overflows:
- Check if pressure thresholds need adjustment
- Verify truncation is actually happening
- Look at `[AgentService] 📈 Step X` logs for token counts

---

## Expected Results

After running all tests, you should see:

✅ **Graceful Error Handling**
- Agent self-corrects from errors
- UI never breaks
- Clear guidance provided

✅ **Adaptive Truncation**
- Context usage monitored in real-time
- Limits adjust automatically
- Pressure levels clearly logged

✅ **Stable Operation**
- No context_length_exceeded errors
- Conversations complete successfully
- Context stays under 150K tokens

---

## Files to Reference

- Implementation: `src/gateway/services/AgentService.ts` (prepareStep)
- Tool errors: `src/core/tools/filesystem.ts` (readFile)
- Test file: `/tmp/test-large-file.js`
- Terminal: `~/...terminals/668841.txt`
- Docs: `docs/IMPLEMENTATION_COMPLETE.md`
