# Chat Persistence - Final Implementation Plan

## The Simple, Proven Approach

Combining:
- ✅ Mastra's format handling (no adapters needed!)
- ✅ V1's proven thresholds and retention strategy
- ✅ V1's structured summary format
- ✅ SQLite with JSONB (no dual files!)
- ✅ Summary + Recent + Search tool pattern

---

## Storage Schema

```sql
-- Chats metadata
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_count INTEGER DEFAULT 0,
  token_count INTEGER DEFAULT 0,
  last_summary_at TEXT
);

-- Messages (store complete Mastra format as JSONB)
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  
  -- Complete message as JSONB (Mastra handles provider differences!)
  message_data TEXT NOT NULL,  -- JSON with role, content, reasoning, toolCalls
  
  -- Metadata for queries/filtering
  role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
  timestamp TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  is_compressed INTEGER DEFAULT 0,  -- In archived summary?
  
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX idx_messages_chat_id ON messages(chat_id);
CREATE INDEX idx_messages_timestamp ON messages(chat_id, timestamp);

-- Structured summaries (JSON format from V1)
CREATE TABLE chat_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  
  -- Structured summary as JSON
  summary_data TEXT NOT NULL,  -- StructuredSummary JSON
  
  -- Range covered
  first_message_id TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  
  -- Metadata
  created_at TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX idx_summaries_chat_id ON chat_summaries(chat_id);
```

---

## Data Flow

### Saving (Streaming from Mastra)

```typescript
// In AgentService.ts
async *streamAgent(chatId: string, userMessage: string, config: AgentConfig) {
  // 1. Save user message (simple JSONB)
  await storage.saveMessage(chatId, {
    id: generateId(),
    role: 'user',
    content: userMessage,
    timestamp: new Date().toISOString(),
  });
  
  // 2. Load history for LLM (with summary if available)
  const history = await storage.loadMessagesForLLM(chatId);
  
  // 3. Stream from Mastra (Mastra handles provider format!)
  let assistantMessage: any = {
    id: generateId(),
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
  };
  
  for await (const chunk of mastraAgent.stream(chatId, userMessage, config, history)) {
    yield chunk;
    
    // Accumulate complete message
    switch (chunk.type) {
      case 'text-delta':
        assistantMessage.content += chunk.payload.text;
        break;
        
      case 'reasoning-delta':
        assistantMessage.reasoning = (assistantMessage.reasoning || '') + chunk.payload.text;
        break;
        
      case 'tool-call':
        assistantMessage.toolCalls = assistantMessage.toolCalls || [];
        assistantMessage.toolCalls.push(chunk.payload);
        break;
        
      case 'tool-result':
        // Update tool call with result
        const toolCall = assistantMessage.toolCalls?.find(t => t.id === chunk.payload.toolCallId);
        if (toolCall) {
          toolCall.status = chunk.payload.error ? 'error' : 'success';
          toolCall.result = chunk.payload.result;
          toolCall.error = chunk.payload.error;
        }
        break;
        
      case 'done':
        // 4. Save complete assistant message (JSONB with everything!)
        await storage.saveMessage(chatId, assistantMessage);
        
        // 5. Check if summarization needed (V1 thresholds)
        const stats = await storage.getChatStats(chatId);
        if (stats.tokenCount > 50_000) {
          compactionService.scheduleCompaction(chatId);
        }
        break;
    }
  }
}
```

### Loading (For LLM Context)

```typescript
// In ChatStorageService.ts
async loadMessagesForLLM(chatId: string): Promise<any[]> {
  // 1. Get uncompressed messages (recent)
  const recentMessages = this.db.prepare(`
    SELECT message_data, token_count FROM messages 
    WHERE chat_id = ? AND is_compressed = 0
    ORDER BY timestamp ASC
  `).all(chatId);
  
  const recent = recentMessages.map(row => ({
    ...JSON.parse(row.message_data),
    token_count: row.token_count,
  }));
  
  // 2. Get latest summary
  const summaryRow = this.db.prepare(`
    SELECT summary_data, message_count FROM chat_summaries 
    WHERE chat_id = ? 
    ORDER BY created_at DESC 
    LIMIT 1
  `).get(chatId);
  
  if (!summaryRow) {
    // No summary yet, return all recent messages
    return recent;
  }
  
  // 3. Build context: formatted summary + recent messages
  const summary: StructuredSummary = JSON.parse(summaryRow.summary_data);
  const summaryMessage = this.formatSummaryForLLM(summary, summaryRow.message_count, recent.length);
  
  return [summaryMessage, ...recent];
}

private formatSummaryForLLM(summary: StructuredSummary, archivedCount: number, recentCount: number) {
  return {
    role: 'user',
    content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 ARCHIVED CONVERSATION SUMMARY (${archivedCount} messages)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️  CRITICAL: DO NOT respond to this summary. FOCUS on the ${recentCount} recent messages below.

───────────────────────────────────────────────────────────

📍 CURRENT FOCUS
${summary.current_focus}

🎯 SESSION INTENT
${summary.session_intent}

📁 FILES ACCESSED
Modified: ${summary.files_accessed?.modified?.join(', ') || 'none'}
Read: ${summary.files_accessed?.read?.join(', ') || 'none'}
Created: ${summary.files_accessed?.created?.join(', ') || 'none'}

💡 KEY REASONING
${summary.key_reasoning?.map(r => `• ${r}`).join('\n') || 'none'}

✅ KEY DECISIONS
${summary.key_decisions?.map(d => `• ${d}`).join('\n') || 'none'}

❌ TRIED AND FAILED
${summary.tried_and_failed?.map(f => `• ${f}`).join('\n') || 'none'}

📋 NEXT STEPS
${summary.next_steps?.map(s => `• ${s}`).join('\n') || 'none'}

🔧 IMPORTANT DETAILS
${summary.important_details ? `
Errors: ${summary.important_details.errors?.join(', ') || 'none'}
APIs: ${summary.important_details.apis_used?.join(', ') || 'none'}
Tools: ${summary.important_details.tool_calls?.join(', ') || 'none'}
` : 'none'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[END OF ARCHIVED CONTEXT]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use search_history tool to query full conversation if needed.`,
  };
}
```

---

## Complete Example

### Before Summarization (50 messages, 55K tokens)

```
Message 1 (user): "Debug my app"
Message 2 (assistant + thinking + tools): "Let me analyze..."
...
Message 50 (user): "What about the login function?"

All loaded to LLM → 55K tokens
```

### After Summarization

**Stored in DB:**
```sql
-- messages table
...
msg_1  | compressed=1 | "Debug my app"
msg_2  | compressed=1 | "Let me analyze..." + thinking + tools
...
msg_40 | compressed=1 | ...
msg_41 | compressed=0 | ... (recent, keep full)
msg_42 | compressed=0 | ...
...
msg_50 | compressed=0 | "What about the login function?"

-- chat_summaries table
summary_1 | {
  "current_focus": "Debugging a Node.js application",
  "session_intent": "Fix login authentication issues",
  "files_accessed": {
    "modified": ["src/app.js", "src/auth.js"],
    "read": ["package.json", "src/routes.js"],
    "created": ["tests/auth.test.js"]
  },
  "key_reasoning": [
    "Identified that JWT token validation was failing",
    "Discovered middleware order was incorrect"
  ],
  "key_decisions": [
    "Use bcrypt for password hashing",
    "Move auth middleware before route handlers"
  ],
  "tried_and_failed": [
    "Tried passport.js but had version conflicts",
    "Attempted to use sessions but cookies weren't persisting"
  ],
  "next_steps": [
    "Test the login endpoint with Postman",
    "Add error handling for expired tokens"
  ],
  "important_details": {
    "errors": ["TypeError: Cannot read property 'token' of undefined"],
    "apis_used": ["bcrypt", "jsonwebtoken"],
    "tool_calls": ["read_file", "edit_file", "bash (npm install)"]
  }
}
```

**Loaded for LLM (25K tokens):**
```javascript
[
  {
    role: 'user',
    content: `📚 ARCHIVED SUMMARY (40 messages)
    
    📍 CURRENT FOCUS: Debugging a Node.js application
    🎯 SESSION INTENT: Fix login authentication issues
    📁 FILES: src/app.js, src/auth.js, ...
    ✅ DECISIONS: Use bcrypt, Move auth middleware...
    ❌ FAILED: passport.js conflicts, session cookies...
    
    [Full formatted summary]`
  },
  { ...message_41 },  // Full with thinking + tools
  { ...message_42 },
  ...
  { ...message_50 },  // Latest user message
]
```

---

## V1 Strategy Applied to V2

| Aspect | V1 Approach | V2 Implementation |
|--------|-------------|-------------------|
| **Storage** | JSONL dual files | SQLite JSONB (single) |
| **Format** | Manual translation | Mastra handles |
| **Thresholds** | 35K/50K | Same ✅ |
| **Retention** | 70% recent | Same ✅ |
| **Structure** | Sections | Same + JSON ✅ |
| **Merging** | Merge summaries | Same ✅ |
| **Framing** | Strong instructions | Same ✅ |
| **Tool access** | None | search_history ✅ |
| **Model** | gpt-5-mini (broken) | gpt-5.2-low ✅ |

---

## Implementation Checklist

### Phase 1: Storage (Day 1)
- [ ] Create SQLite schema
- [ ] Implement `ChatStorageService`
  - [ ] `saveMessage(chatId, messageData)` - Store as JSONB
  - [ ] `loadAllMessages(chatId)` - Parse JSONB
  - [ ] `loadMessagesForLLM(chatId)` - Summary + recent
  - [ ] `getChatStats(chatId)` - Token counts

### Phase 2: Summarization (Day 2)
- [ ] Create `CompactionService`
  - [ ] V1 threshold logic (35K/50K)
  - [ ] V1 retention logic (70%, keep from last user)
  - [ ] Generate structured summary
  - [ ] Merge with existing summary
  - [ ] Validate output (prevent empty summary)
- [ ] Add structured summary types
- [ ] Add summary formatting

### Phase 3: Integration (Day 3)
- [ ] Update `AgentService` to use new storage
- [ ] Pass loaded history to Mastra
- [ ] Save messages after streaming
- [ ] Trigger compaction check
- [ ] Add IPC handlers (load, list, delete)

### Phase 4: UI (Day 4)
- [ ] Load history when switching chats
- [ ] Show "Summarizing..." indicator
- [ ] Display token usage in UI
- [ ] Add manual "Compress" button

### Phase 5: Tools (Day 5)
- [ ] Implement `search_history` tool
- [ ] Register with Mastra
- [ ] Test LLM can search old messages

---

## Key Code Snippets

### Message Storage (JSONB)
```typescript
await storage.saveMessage(chatId, {
  id: 'msg_123',
  role: 'assistant',
  content: 'I can help with that.',
  reasoning: 'Let me think about the best approach...',
  toolCalls: [{
    id: 'call_abc',
    toolName: 'read_file',
    args: { path: 'src/app.js' },
    status: 'success',
    result: 'const app = ...',
  }],
  timestamp: '2026-02-10T...',
});
```

### Loading for LLM
```typescript
const history = await storage.loadMessagesForLLM(chatId);
// Returns: [summaryMessage, ...recentMessages]

// Pass to Mastra (it handles provider format!)
const stream = await agent.stream(userMessage, { 
  messages: history 
});
```

### Summarization Trigger
```typescript
// After saving assistant message
const stats = await storage.getChatStats(chatId);

if (stats.tokenCount > 35_000 && !this.summarizedThisTurn) {
  this.compactionService.scheduleCompaction(chatId);
  this.summarizedThisTurn = true;
  setTimeout(() => this.summarizedThisTurn = false, 5000);
}
```

---

## Benefits

✅ **Simple**: One storage system, one format (JSONB)  
✅ **Proven**: V1's tested thresholds and retention  
✅ **Powerful**: Structured summaries + search tool  
✅ **Clean**: Mastra handles all provider differences  
✅ **Reliable**: No orphaned files, no dual writes  
✅ **Debuggable**: Inspect complete messages in DB  

---

## Next Step

Ready to implement Phase 1 (Storage)? This will give us:
- SQLite database with JSONB messages
- Save/load functionality
- Foundation for summarization

Let me know and I'll start building! 🚀
