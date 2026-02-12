# Manual Test Guide: Chat ID Conversion & Title Generation

## What We're Testing

1. ✅ App opens with an active tab
2. ✅ Temp chat ID converts to permanent UUID when sending first message
3. ✅ Title is generated and updates the tab
4. ✅ Chat and messages are saved to SQLite

## Test Instructions

### Step 1: Start the App

```bash
npm start
```

**Open DevTools:** Go to `View → Developer → JavaScript Console`

### Step 2: Verify Initial State

**Expected Console Logs:**
```
[App] Component rendering
[App] Current state - tabs: 0, activeTabId: undefined
[App] useEffect running for initialization
[App] Initializing... Current tabs: 0
[App] No tabs found, creating initial tab
[App] Created chat: temp-1234567890-xxxxx
[TabStore] Creating tab: chat-temp-1234567890-xxxxx and setting as active
[TabStore] Tab created and activated: chat-temp-1234567890-xxxxx
[TabStore] Current activeTabId: chat-temp-1234567890-xxxxx
[App] Created initial tab: chat-temp-1234567890-xxxxx for chat: temp-1234567890-xxxxx
[App] Active tab after creation: chat-temp-1234567890-xxxxx
```

**Visual Check:**
- ✅ Tab bar shows "New Chat" tab
- ✅ Chat input is enabled (not grayed out)

**If you see `activeTab: undefined`:**
- ❌ The initialization failed - share ALL console logs

### Step 3: Send First Message

1. Type a message (e.g., "What is the capital of France?")
2. Click Send

**Expected Console Logs (UI):**
```
[useAgent] sendMessage START {message: "What is the capital of France?"}
[useAgent] activeTab: chat-temp-1234567890-xxxxx  ✅ NOT undefined!
[useAgent] Available tabs: [{id: 'chat-temp-1234567890-xxxxx', entityId: 'temp-1234567890-xxxxx'}]
[useAgent] Using tab chat-temp-1234567890-xxxxx with entityId: temp-1234567890-xxxxx
[useAgent] First message - creating permanent chat before streaming
[useAgent] Created permanent chat: abc-def-123-uuid  ✅ Clean UUID!
[TabStore] updateTabId: ... → chat-abc-def-123-uuid
[useAgent] Updated tab: chat-temp-1234567890-xxxxx → chat-abc-def-123-uuid
[useAgent] User message added to store
[useAgent] gateway.stream completed successfully
[useAgent] Generating title for first message (chatId: abc-def-123-uuid)
[useAgent] Generated title: Capital of France Question  ✅
[useAgent] Updating tab chat-abc-def-123-uuid title to: Capital of France Question
[TabStore] Updating tab chat-abc-def-123-uuid title to: Capital of France Question
```

**Expected Console Logs (Backend):**
```
✓ Created new chat: abc-def-123-uuid  ✅ Clean UUID, no "chat-" prefix!
[Agent WS] Starting stream for chat abc-def-123-uuid
✓ Created chat session for abc-def-123-uuid with openai/gpt-4o-mini
[Agent WS] Stream complete for chat abc-def-123-uuid. Chunks: XX
✓ Generated title for abc-def-123-uuid: "Capital of France Question"
```

**Visual Check:**
- ✅ Tab title changes from "New Chat" to "Capital of France Question" (or similar)
- ✅ Blue dot appears during streaming
- ✅ Blue dot disappears when complete
- ✅ Message and response appear in chat

### Step 4: Verify SQLite Persistence

**Check the SQLite database:**
```bash
sqlite3 ~/Papr/papr.db "SELECT id, title FROM chats ORDER BY created_at DESC LIMIT 1;"
```

**Expected Output:**
```
abc-def-123-uuid|Capital of France Question
```

**Check messages:**
```bash
sqlite3 ~/Papr/papr.db "SELECT chat_id, message_role, substr(message, 1, 50) FROM messages WHERE chat_id = 'abc-def-123-uuid';"
```

**Expected Output:**
```
abc-def-123-uuid|user|What is the capital of France?
abc-def-123-uuid|assistant|The capital of France is Paris...
```

### Step 5: Send Second Message

1. Type another message (e.g., "Tell me about its famous tower")
2. Click Send

**Expected Console Logs:**
```
[useAgent] activeTab: chat-abc-def-123-uuid  ✅ Permanent ID now!
[useAgent] Using tab chat-abc-def-123-uuid with entityId: abc-def-123-uuid
[useAgent] Skipping chat creation - not first message  ✅
```

**Visual Check:**
- ✅ Tab title stays the same (no new title generation)
- ✅ Message streams correctly
- ✅ Chat history is preserved

## Troubleshooting

### If activeTab is undefined:
Share the **complete** console logs from app startup, including all `[App]` and `[TabStore]` messages.

### If tab title doesn't update:
Check if you see `[TabStore] updateTabTitle: tab chat-XXX not found` - this means the tab ID doesn't match.

### If SQLite is empty:
Check backend logs for "✓ Created chat" and "✓ Generated title" messages.

## Success Criteria

✅ **Tab exists and is active on app start** (activeTabId is set)  
✅ **Temp ID converts to permanent UUID** (no "chat-" or "temp-" prefix in backend)  
✅ **Tab ID updates in UI** (from `chat-temp-xxx` to `chat-uuid`)  
✅ **Title generates and updates tab** (visible in UI)  
✅ **Chat saved in SQLite** (~/Papr/papr.db has the chat)  
✅ **Messages saved in SQLite** (both user and assistant messages)  

---

**Date:** 2026-02-11  
**What to do:** Run `npm start` and follow these steps exactly
