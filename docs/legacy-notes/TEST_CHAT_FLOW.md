# Chat Flow Test - Manual Verification

## Automated Test Results

✅ **Tab Activation Fixed** - The race condition has been resolved:
- Tabs are created and activated atomically
- `activeTabId` is consistently set
- No more "activeTab: undefined" errors

## What Was Tested Automatically

1. ✅ App initialization creates a temporary chat tab
2. ✅ Tab is immediately activated (`activeTabId` is set)
3. ✅ Message input triggers `handleSendMessage`
4. ✅ `activeTabId` is available in `ChatContainer`

## Manual Testing Required (In Electron App)

Since `window.electronAPI` is only available in Electron, you need to manually test the full flow in the actual app:

### Test Steps:

1. **Start the app:**
   ```bash
   npm start
   ```

2. **Open DevTools** (⌘+Option+I on Mac)

3. **Send a test message** in the chat:
   - Type: "What is 2+2?"
   - Press Enter

4. **Check Console Logs** for the following sequence:

   **Expected Log Sequence:**
   ```
   [useAgent] sendMessage START
   [useAgent] activeTab: {...}  // Should NOT be undefined!
   [useAgent] chatId: temp-xxx
   [useAgent] First message - creating permanent chat before streaming
   [useAgent] Created permanent chat: 62f5cf89-...
   [TabStore] Updating tab ID: chat-temp-xxx → chat-62f5cf89-...
   [useAgent] User message added to store
   [Gateway.stream] START
   ... [streaming chunks] ...
   [useAgent] gateway.stream completed successfully
   [useAgent] Generating title for first message
   [useAgent] Generated title: Simple Math Question
   [TabStore] Updating tab chat-62f5cf89-... title to: Simple Math Question
   ```

5. **Verify in UI:**
   - ✅ Chat tab name changes from "New Chat" to generated title (e.g., "Simple Math Question")
   - ✅ Chat ID in URL/state changes from `temp-xxx` to permanent UUID
   - ✅ Message persists in SQLite database

### If You See Errors:

- **"activeTab: undefined"** → The atomic update didn't work (shouldn't happen now!)
- **"Tab not found"** → ID mismatch between stores
- **"electronAPI not available"** → Preload script not loaded

## Database Verification

After sending a message, check SQLite to verify persistence:

```bash
sqlite3 ~/Papr/data/local/chat_store.db
```

```sql
-- Check the chat was created with correct ID (should be UUID, not temp-xxx)
SELECT id, title, created_at FROM chats ORDER BY created_at DESC LIMIT 1;

-- Check messages were persisted
SELECT chat_id, role, content FROM messages ORDER BY timestamp DESC LIMIT 2;
```

**Expected:**
- Chat ID should be a plain UUID (e.g., `62f5cf89-98d6-4849-9caf-df10a4b205ff`)
- Chat title should match the generated title
- Messages should be stored with the permanent chat ID

## Summary

The **tab activation bug is fixed** via automated testing. The remaining flow (API key retrieval, streaming, title generation, persistence) requires manual testing in the Electron environment due to the `electronAPI` dependency.
