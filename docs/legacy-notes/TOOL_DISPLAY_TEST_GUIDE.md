# Tool Display Test Guide

**Fix**: Tool calls now show detailed information with real-time status indicators

---

## What Was Fixed

### Before ❌
```
▼ Exploring
  → bash
```
- Only showed tool name
- No loading indicator
- No success/error feedback
- No command details

### After ✅
```
▼ Exploring
  → Running ls -la ~/Dropbox ⏳
```
- Shows actual command being executed
- Real-time status: ⏳ (loading) → ✓ (success) or ✗ (error)
- Matches V1 behavior

---

## Testing Instructions

### 1. Start the App

```bash
npm start
```

Wait for both Electron and Gateway to be ready.

### 2. Test Basic Bash Command

**Prompt**: "List files in my Dropbox directory"

**Expected Behavior**:

1. **During thinking**: 
   ```
   ▼ Deep in thought
     **Running a search with Bash**
     I need to respond that I can use the Bash tool...
   ```

2. **Tool executing**:
   ```
   ▼ Exploring
     → Running ls -la ~/Dropbox ⏳
   ```

3. **Tool completed**:
   ```
   ▼ Exploring
     → Ran ls -la ~/Dropbox ✓
   ```

4. **Console logs** (check browser DevTools):
   ```
   [useAgent] 🔧 Tool call: bash { command: "ls -la ~/Dropbox" }
   [useAgent] 🔄 Updating UI with 1 tool call(s)
   [useAgent] ✓ Tool result for bash: total 0\ndrwxr-xr-x...
   [useAgent] 🔄 Updating UI after tool result, 1 tool call(s): [{ name: "bash", status: "success" }]
   ```

### 3. Test Long Command Truncation

**Prompt**: "Search for the word 'reach' in all JavaScript files recursively starting from ~/Dropbox"

**Expected**: Command truncated to 60 chars
```
▼ Exploring
  → Running grep -r "reach" ~/Dropbox/**/*.js -l -i --ex... ⏳
```

### 4. Test Multiple Tool Calls

**Prompt**: "Add ~/Papr/ to Finder sidebar favorites"

**Expected**: Shows multiple steps
```
▼ Exploring
  → Running osascript -e 'tell application "Finder"... ⏳
```

Then after completion:
```
▼ Exploring
  → Ran osascript -e 'tell application "Finder"... ✓
```

### 5. Test Error Handling

**Prompt**: "Run this command: ls /nonexistent/directory"

**Expected**:
```
▼ Exploring
  → Running ls /nonexistent/directory ⏳
```

Then:
```
▼ Exploring
  → Ran ls /nonexistent/directory ✗
```

Console should show:
```
[useAgent] ✗ Tool error (bash): ls: /nonexistent/directory: No such file or directory
```

---

## Verification Checklist

### UI Checks

- [ ] **Tool name is descriptive**: Shows "Running ls -la ~/Dropbox" not just "bash"
- [ ] **Loading indicator appears**: ⏳ emoji shows while executing
- [ ] **Success indicator appears**: ✓ emoji shows when done
- [ ] **Error indicator appears**: ✗ emoji shows on failure
- [ ] **Text changes on completion**: "Running" → "Ran"
- [ ] **Long commands are truncated**: Shows "..." after 60 chars
- [ ] **ExploringCard is collapsible**: Can click to collapse/expand

### Console Checks

Open browser DevTools (Cmd+Option+I) and verify:

- [ ] **Tool call logged**: `[useAgent] 🔧 Tool call: bash { command: "..." }`
- [ ] **UI update logged**: `[useAgent] 🔄 Updating UI with 1 tool call(s)`
- [ ] **Result logged**: `[useAgent] ✓ Tool result for bash: ...`
- [ ] **Status update logged**: `[useAgent] 🔄 Updating UI after tool result`

### Backend Checks

Check terminal where `npm start` is running:

- [ ] **Chunks received**: `[AgentService] Received chunk type: tool-call`
- [ ] **Result received**: `[AgentService] Received chunk type: tool-result`
- [ ] **Stream complete**: `[Agent WS] Stream complete for chat ...`

---

## Common Issues & Solutions

### Issue: Still shows just "bash"

**Solution**: Hard refresh the browser
```bash
# In the app, press:
Cmd+Shift+R  (Mac)
Ctrl+Shift+R (Windows/Linux)
```

### Issue: No status indicators (⏳, ✓, ✗)

**Check**: CSS is loaded
1. Open DevTools
2. Go to Elements tab
3. Find `.exploring-tool-spinner` class
4. Verify animation is present

**Fix**: Clear cache and restart

### Issue: No console logs

**Check**: Console filter
1. Open DevTools Console
2. Make sure filter is not hiding `[useAgent]` logs
3. Clear "Hide all messages" filter if enabled

### Issue: Tool calls not updating

**Check**: React re-renders
1. In console, type: `window.localStorage.clear()`
2. Refresh app (Cmd+R)
3. Try again

---

## Architecture Flow (For Debugging)

```
1. User sends message
   ↓
2. AgentService.streamAgent() yields tool-call chunk
   ↓
3. WebSocket sends: { type: "agent:chunk", data: { type: "tool-call", payload: {...} } }
   ↓
4. UI gateway.ts receives: response.type === "agent:chunk"
   ↓
5. Calls: onChunk(response.data)
   ↓
6. useAgent.handleStreamChunk() processes: case "tool-call"
   ↓
7. Updates: toolCallsMapRef.current.set(toolCallId, { status: "calling", ... })
   ↓
8. Updates chatStore: chatStates.set(chatId, { messages: [...updatedMessages] })
   ↓
9. MessageItem renders: <ExploringCard toolCalls={message.toolCalls} />
   ↓
10. ExploringCard maps: toolCalls.map(tc => getToolCallDisplayText(tc))
    ↓
11. UI shows: "→ Running ls -la ~/Dropbox ⏳"
```

---

## Files to Check if Issues Occur

### Frontend (UI)

1. **ui/components/Chat/ExploringCard.tsx** - Rendering logic
2. **ui/components/Chat/ExploringCard.css** - Status indicator styles
3. **ui/hooks/useAgent.ts** - Chunk processing
4. **ui/src/lib/gateway.ts** - WebSocket client

### Backend (Gateway)

1. **src/gateway/services/AgentService.ts** - Chunk generation
2. **src/gateway/websocket/agent.ts** - WebSocket server
3. **src/core/tools/bash.ts** - Bash tool execution

---

## Success Criteria

✅ **All tests pass**:
1. Tool name shows detailed info (command/description)
2. Status indicators appear (⏳ → ✓/✗)
3. Console logs confirm chunk flow
4. Multiple tool calls work
5. Error states handled gracefully

---

## Next Steps After Verification

Once verified working:

1. **Test other tools**: Try document creation, app operations
2. **Test rapid tool calls**: Multiple sequential commands
3. **Test long-running tools**: Commands that take >5 seconds
4. **Update TOOL_GAPS.md**: Mark UI display gap as closed

---

## Support

If issues persist:
1. Check `TOOL_DISPLAY_FIX.md` for technical details
2. Review console logs for errors
3. Check Network tab for WebSocket messages
4. Verify AgentService is yielding chunks correctly
