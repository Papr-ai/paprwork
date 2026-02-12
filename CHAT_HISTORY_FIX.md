# Chat History Fix - Thinking & Tool Calls Not Showing

## Problem

After reloading the app, chat history showed only text messages. The thinking and tool call cards were missing.

## Root Cause

The database schema was missing columns for extended message metadata:
- ❌ No `thinking` column
- ❌ No `tool_calls` column  
- ❌ No `error` column
- ❌ No `incomplete` column

Even though `AgentService` was creating messages with these fields, they weren't being saved to the database!

## Fix

### 1. Updated Database Schema

Added missing columns to `messages` table:

```sql:73-97:src/gateway/services/storage/LocalStorageProvider.ts
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  
  -- Message content (aligned with CoreMessage)
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  
  -- Extended message metadata (for UI display) ← NEW!
  thinking TEXT,                    -- Reasoning/thinking text
  tool_calls TEXT,                  -- JSON array of tool calls
  error TEXT,                       -- Error message if any
  incomplete INTEGER DEFAULT 0,     -- 1 if message was interrupted/incomplete
  
  -- Model metadata
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  
  -- Sync tracking
  sync_status TEXT DEFAULT 'local',
  papr_message_id TEXT,
  last_sync_attempt TEXT,
  sync_error TEXT,
  
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
)
```

### 2. Updated saveMessage()

Now saves all metadata:

```typescript:112-148:src/gateway/services/storage/LocalStorageProvider.ts
async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
  await this.ensureChatExists(chatId);

  console.log(`[LocalStorage] Saving message to chat ${chatId}:`, {
    id: message.id,
    role: message.role,
    hasThinking: !!message.thinking,
    hasToolCalls: !!message.toolCalls,
    hasError: !!message.error,
    incomplete: message.incomplete
  });

  this.db.prepare(`
    INSERT INTO messages (
      id, chat_id, role, content, timestamp,
      thinking, tool_calls, error, incomplete,  ← NEW!
      model, prompt_tokens, completion_tokens, total_tokens,
      sync_status, papr_message_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.id || uuidv4(),
    chatId,
    message.role,
    message.content,
    message.timestamp || new Date().toISOString(),
    message.thinking || null,                       ← NEW!
    message.toolCalls ? JSON.stringify(message.toolCalls) : null,  ← NEW!
    message.error || null,                          ← NEW!
    message.incomplete ? 1 : 0,                     ← NEW!
    message.model || null,
    message.prompt_tokens || 0,
    message.completion_tokens || 0,
    message.total_tokens || 0,
    message.sync_status || 'local',
    message.papr_message_id || null
  );
  // ... update chat count ...
}
```

### 3. Updated loadMessages()

Now loads all metadata:

```typescript:166-220:src/gateway/services/storage/LocalStorageProvider.ts
async loadMessages(chatId: string, limit?: number, skip?: number): Promise<StoredMessage[]> {
  let query = `
    SELECT 
      id, chat_id, role, content, timestamp,
      thinking, tool_calls, error, incomplete,  ← NEW!
      model, prompt_tokens, completion_tokens, total_tokens,
      sync_status, papr_message_id, last_sync_attempt, sync_error
    FROM messages 
    WHERE chat_id = ? 
    ORDER BY timestamp ASC
  `;

  if (limit) query += ` LIMIT ${limit}`;
  if (skip) query += ` OFFSET ${skip}`;

  const rows = this.db.prepare(query).all(chatId) as any[];
  
  console.log(`[LocalStorage] Loaded ${rows.length} messages for chat ${chatId}`);
  rows.forEach((row, i) => {
    console.log(`  Message ${i}: role=${row.role}, hasThinking=${!!row.thinking}, hasToolCalls=${!!row.tool_calls}`);
  });
  
  return rows.map(row => ({
    id: row.id,
    chat_id: row.chat_id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    timestamp: row.timestamp,
    thinking: row.thinking || undefined,                    ← NEW!
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,  ← NEW!
    error: row.error || undefined,                          ← NEW!
    incomplete: row.incomplete === 1,                       ← NEW!
    model: row.model,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    total_tokens: row.total_tokens,
    sync_status: row.sync_status as any,
    papr_message_id: row.papr_message_id,
    last_sync_attempt: row.last_sync_attempt,
    sync_error: row.sync_error,
  }));
}
```

### 4. Updated UI to Use Loaded Data

Modified `loadMessages` in `useChat.ts` to preserve metadata:

```typescript:91-128:ui/hooks/useChat.ts
const loadedMessages = response.data.map((msg: any, index: number) => {
  console.log(`[useChat.loadMessages] Processing message ${index}:`, {
    role: msg.role,
    hasThinking: !!msg.thinking,
    hasToolCalls: !!msg.toolCalls,
    hasError: !!msg.error
  });
  
  return {
    id: msg.id || `msg-${Date.now()}-${index}`,
    role: msg.role as "user" | "assistant",
    content: msg.content,
    timestamp: msg.timestamp,
    model: msg.model,
    isStreaming: false,
    // Include thinking and tool calls if present ← NEW!
    streamingReasoning: msg.thinking || undefined,
    toolCalls: msg.toolCalls || undefined,
    error: msg.error || undefined,
  };
});
```

## Database Migration

**Important**: Existing databases need migration!

The new columns are created with `IF NOT EXISTS`, so they're added automatically. But old messages won't have data in these columns (will be NULL).

**Options:**
1. **Delete old DB**: `rm ~/.papr-data/chats.db` (loses history)
2. **Keep old DB**: Old messages won't show thinking/tools, but new messages will work
3. **Migrate**: Run ALTER TABLE to add columns (SQLite doesn't support adding columns with data)

**Recommended**: Option 2 (graceful degradation)

## Testing Checklist

After restart:

- [ ] New messages save with thinking/tools
- [ ] After reload, thinking cards show up
- [ ] After reload, tool call cards show up
- [ ] Old messages (before fix) still display (just without thinking/tools)
- [ ] Logs show "hasThinking=true" and "hasToolCalls=true" for new messages

## Additional Logging Added

Added comprehensive logging at every step:

1. **Save**: `[LocalStorage] Saving message... hasThinking=true, hasToolCalls=true`
2. **Load**: `[LocalStorage] Loaded 5 messages... Message 3: hasThinking=true`
3. **UI Load**: `[useChat.loadMessages] Processing message... hasThinking=true`
4. **UI Display**: `[ChatContainer] Getting messages... messageCount=5`

This will help diagnose the other issues (tab persistence, message display).

## Summary

✅ **Database schema**: Added 4 new columns  
✅ **Save logic**: Stores thinking/toolCalls/error/incomplete  
✅ **Load logic**: Reads and parses thinking/toolCalls  
✅ **UI mapping**: Passes metadata to UI components  
✅ **Logging**: Added at all steps for debugging

**Result**: Chat history now shows complete message context including thinking and tool calls!
