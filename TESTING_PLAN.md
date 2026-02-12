# Testing Plan After Restart

## Changes Applied

### 1. Database Migration ✅
- Added `thinking`, `tool_calls`, `error`, `incomplete` columns
- Automatic migration on startup (checks and adds if missing)
- Safe for existing databases (no data loss)

### 2. Tool Status Indicators ✅
- Replaced ⏳ emoji with liquid glass pulsing dot
- Shows loading → success (✓) → error (✗) states
- Matches liquid glass design aesthetic

### 3. Comprehensive Logging ✅
- Database: Logs column migration
- Storage: Logs save/load with metadata
- App: Logs tab restoration flow
- ChatContainer: Logs message state
- useChat: Logs message loading attempts

### 4. Backend Fixes ✅
- UI timeout: 60s → 300s (matches backend)
- stopWhen: 100 steps (allows multi-tool workflows)
- Debug logging for context size and tool results

---

## Testing Steps

### Step 1: Fresh Restart
```bash
# Stop current app
Ctrl+C in terminal

# Start fresh
npm start
```

### Step 2: Check Migration Logs
Look for in terminal:
```
[LocalStorage] Messages table columns: [...]
[LocalStorage] Adding "thinking" column...
[LocalStorage] Adding "tool_calls" column...
[LocalStorage] Adding "error" column...
[LocalStorage] Adding "incomplete" column...
[LocalStorage] Database migration complete
```

### Step 3: Test Tab Persistence
**On App Open** (fresh launch):
- [ ] App opens with last active tab selected (not "no tab selected")
- [ ] Console shows: `[App] ✅ Active tab already persisted: chat-xxx`
- [ ] Messages load immediately

### Step 4: Test Message Loading
**Switch between tabs**:
- [ ] Click different chat in sidebar
- [ ] Messages appear immediately (not after second click)
- [ ] Console shows: `[useChat.useEffect] 🔄 Loading messages for xxx`
- [ ] Console shows: `[LocalStorage] Loaded X messages for chat xxx`
- [ ] Console shows: `[ChatContainer] messageCount: X`

### Step 5: Test Thinking/Tool Cards in History
**Load an old chat** (with previous messages):
- [ ] Old messages show text (thinking=NULL, graceful degradation)
- [ ] Console shows: `Message 0: hasThinking=false, hasToolCalls=false`

**Send a new message**:
- [ ] Thinking card shows during streaming
- [ ] Tool calls show with liquid glass loading dot
- [ ] After completion, tools show ✓ checkmark
- [ ] After refresh/reload, thinking and tools persist

### Step 6: Test Long Workflows
**Ask complex question** (e.g., "analyze this codebase"):
- [ ] Multiple tool calls execute (not just 1)
- [ ] Each tool shows pulsing dot while running
- [ ] Each tool shows ✓ when complete
- [ ] Agent provides text response after tools
- [ ] No timeout errors (5 min timeout)

### Step 7: Verify No Errors
**Console should NOT show**:
- ❌ `no such column: thinking`
- ❌ `Cannot access 'b' before initialization`
- ❌ `Stream timeout` (unless > 5 minutes)
- ❌ `context_length_exceeded` (unless genuinely over 200K)

---

## Expected Console Output (Success)

### On Startup
```
[Gateway] Initializing services...
[LocalStorage] Database migration complete
✓ AgentService initialized
  System prompt: 9024 characters
[Gateway] All services initialized
[App] ✅ Tab store already hydrated
[App] ✅ Active tab already persisted: chat-xxx
[useChat.useEffect] Active chat changed to: xxx
[useChat.useEffect] 🔄 Loading messages for xxx...
[LocalStorage] Loaded 5 messages for chat xxx
  Message 0: role=user, hasThinking=false, hasToolCalls=false
  Message 1: role=assistant, hasThinking=false, hasToolCalls=false
[ChatContainer] messageCount: 5
```

### During Agent Response
```
[AgentService] Received chunk type: reasoning-delta (x100)
[AgentService] Received chunk type: tool-call
[useAgent] Tool call: bash - command: ls -la
[AgentService] Tool bash raw result: 1234 chars
[AgentService] After truncation: 1234 chars
[AgentService] Received chunk type: tool-result
[useAgent] Tool result for bash: ...
[AgentService] Received chunk type: text-delta (x50)
[AgentService] Received chunk type: finish
```

### On Message Save
```
[LocalStorage] Saving message to chat xxx:
  id: msg-xxx
  role: assistant
  hasThinking: true
  hasToolCalls: true
  hasError: false
  incomplete: false
```

---

## Known Issues (Expected)

### Old Messages
Old messages (before migration) will have NULL for thinking/toolCalls:
```
Message 0: hasThinking=false, hasToolCalls=false
```
✅ **Expected**: Old chats show text only (graceful degradation)

### First Message in Fresh Chat
First message might take longer:
- Lazy-loads API keys
- Creates chat session
- Initializes agent

✅ **Expected**: 1-2 second delay on first message

---

## Regression Checks

Make sure these still work:

- [ ] Creating new chat
- [ ] Switching models
- [ ] Sending messages
- [ ] Streaming responses
- [ ] Tool execution
- [ ] Error handling
- [ ] Multiple parallel chats

---

## If Issues Persist

### "No tab selected" still shows
**Check**: 
- Does console show `activeTabId: chat-xxx` or `activeTabId: null`?
- Does localStorage have tabs/activeTabId saved?

**Debug**:
```javascript
// In browser console:
localStorage.getItem('tab-store')
```

### Messages still don't load
**Check**:
- Does console show `[LocalStorage] Loaded X messages`?
- Does console show `[ChatContainer] messageCount: X`?
- Any SQLite errors?

**Debug**: Check if useChat.loadMessages is being called

### Thinking/Tools still missing
**Check**:
- Did migration run? (`[LocalStorage] Adding "thinking" column...`)
- Are new messages being saved? (`hasThinking: true`)

**Debug**: Check database directly:
```bash
sqlite3 ~/.papr-data/chats.db "PRAGMA table_info(messages);"
```

---

## Success Criteria

All three issues resolved:
1. ✅ Thinking and tool cards show in history
2. ✅ Active tab persists on app relaunch  
3. ✅ Messages load immediately on tab switch

Plus visual improvements:
4. ✅ Liquid glass loading indicator (not emoji)
5. ✅ Status indicators for tools (loading/success/error)
6. ✅ Long workflows complete without timeout

---

**Ready to test! Restart the app and verify all items in this checklist.**
