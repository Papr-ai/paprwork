# Chat Persistence - The Actually Simple Way

## Key Insights

1. ✅ **Mastra handles all format conversion** - We don't need adapters!
2. ✅ **Store raw message as JSONB** - Keep complete structure
3. ✅ **Summary = Last N messages + compressed history** - Simple and effective
4. ✅ **Full history as searchable tool** - LLM can query when needed

---

## Revised Storage Schema (Much Simpler!)

```sql
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_count INTEGER DEFAULT 0,
  token_count INTEGER DEFAULT 0,
  last_compaction_at TEXT
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
  
  -- Store the ENTIRE message as JSONB (including thinking, tool calls, etc.)
  message_data TEXT NOT NULL,  -- JSONB format
  
  -- Metadata for queries
  timestamp TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  is_compressed INTEGER DEFAULT 0,  -- Boolean: is this in compressed history?
  
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX idx_messages_chat_id ON messages(chat_id);
CREATE INDEX idx_messages_timestamp ON messages(chat_id, timestamp);

-- Compressed summaries (generated periodically)
CREATE TABLE chat_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  
  -- Range this summary covers
  first_message_id TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  
  -- When it was created
  created_at TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX idx_summaries_chat_id ON chat_summaries(chat_id);
```

---

## What Goes in `message_data` (JSONB)

**Everything Mastra gives us:**

```typescript
// User message (simple)
{
  role: "user",
  content: "Debug my app.js"
}

// Assistant message with thinking + tools (Mastra format)
{
  role: "assistant",
  content: "I'll help debug this. Let me read the file.",
  reasoning: "The user wants to debug app.js. I should first read the file to understand the code structure...",
  toolCalls: [
    {
      id: "call_abc123",
      toolName: "read_file",
      args: { path: "src/app.js" },
      status: "success",
      result: "const app = require('express')();\n..."
    }
  ]
}
```

**Mastra's internal format is already unified** - it handles the provider differences for us!

---

## Saving Messages (Dead Simple)

```typescript
// In AgentService.ts
async *streamAgent(chatId: string, message: string, config: AgentConfig) {
  // 1. Save user message
  await this.storage.saveMessage(chatId, {
    role: 'user',
    content: message,
  });
  
  // 2. Load history (Mastra handles format!)
  const history = await this.storage.loadMessages(chatId);
  
  // 3. Stream from Mastra
  let assistantMessage: any = { role: 'assistant', content: '' };
  
  for await (const chunk of this.mastraAgent.stream(chatId, message, config)) {
    yield chunk; // Stream to UI
    
    // Accumulate the complete message
    if (chunk.type === 'text-delta') {
      assistantMessage.content += chunk.payload.text;
    } else if (chunk.type === 'reasoning-delta') {
      assistantMessage.reasoning = (assistantMessage.reasoning || '') + chunk.payload.text;
    } else if (chunk.type === 'tool-call') {
      assistantMessage.toolCalls = assistantMessage.toolCalls || [];
      assistantMessage.toolCalls.push(chunk.payload);
    } else if (chunk.type === 'done') {
      // Save complete assistant message
      await this.storage.saveMessage(chatId, assistantMessage);
      
      // Check if compaction needed
      const stats = await this.storage.getChatStats(chatId);
      if (stats.messageCount > 50) {  // Simple threshold
        this.compactionService.scheduleCompaction(chatId);
      }
    }
  }
}
```

---

## Loading Messages for LLM (The Smart Way)

### Strategy: Recent Full + Old Summary + Search Tool

```typescript
// In ChatStorageService.ts
async loadMessagesForLLM(chatId: string, recentCount = 10) {
  const allMessages = await this.loadAllMessages(chatId);
  
  // If few messages, return all
  if (allMessages.length <= recentCount) {
    return allMessages;
  }
  
  // Get most recent summary (if exists)
  const summary = await this.getLatestSummary(chatId);
  
  // Get recent N messages (full)
  const recentMessages = allMessages.slice(-recentCount);
  
  // Build context with summary + recent + search tool
  const context = [];
  
  // 1. Add system message with summary
  if (summary) {
    context.push({
      role: 'system',
      content: `## Previous Conversation Summary (${summary.message_count} messages)

${summary.summary_text}

---

You now have access to the full conversation history via the \`search_history\` tool if you need to reference specific details.`,
    });
  }
  
  // 2. Add recent messages (full detail)
  context.push(...recentMessages);
  
  return context;
}

// Load all messages (for search tool or UI)
async loadAllMessages(chatId: string) {
  const rows = this.db.prepare(`
    SELECT message_data, timestamp 
    FROM messages 
    WHERE chat_id = ? 
    ORDER BY timestamp ASC
  `).all(chatId);
  
  return rows.map(row => JSON.parse(row.message_data));
}

// Get latest summary
async getLatestSummary(chatId: string) {
  return this.db.prepare(`
    SELECT * FROM chat_summaries 
    WHERE chat_id = ? 
    ORDER BY created_at DESC 
    LIMIT 1
  `).get(chatId);
}
```

---

## History Search Tool (For LLM)

Give the LLM a tool to search full history when needed:

```typescript
// In ToolRegistry
const searchHistoryTool = {
  name: 'search_history',
  description: 'Search the full conversation history for specific information. Use this when you need to recall details from earlier in the conversation.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to search for (keywords, topics, or specific information)',
      },
      message_range: {
        type: 'string',
        description: 'Optional: "first_10" or "last_20" or "all"',
        default: 'all',
      },
    },
    required: ['query'],
  },
  execute: async (args: { query: string; message_range?: string }) => {
    // Load full history
    const allMessages = await storage.loadAllMessages(currentChatId);
    
    // Simple keyword search (can be improved with embeddings later)
    const matches = allMessages.filter(msg => 
      msg.content.toLowerCase().includes(args.query.toLowerCase())
    );
    
    return {
      found: matches.length,
      matches: matches.slice(0, 5).map(m => ({
        role: m.role,
        content: m.content.slice(0, 500), // Truncate for context
        timestamp: m.timestamp,
      })),
    };
  },
};
```

---

## When to Generate Summaries

### Trigger Points

1. **Message count threshold**: Every 50 messages
2. **Token threshold**: Every 50K tokens
3. **User switches chat**: Summarize in background
4. **Manual trigger**: User clicks "Compress"

### Summary Generation

```typescript
// In CompactionService.ts
async generateSummary(chatId: string) {
  const messages = await this.storage.loadAllMessages(chatId);
  const recentCount = 10;
  
  // Don't summarize if too few messages
  if (messages.length <= recentCount) {
    return;
  }
  
  // Check if we already have a recent summary
  const lastSummary = await this.storage.getLatestSummary(chatId);
  if (lastSummary) {
    // Only summarize new messages since last summary
    const newMessages = messages.filter(m => 
      new Date(m.timestamp) > new Date(lastSummary.created_at)
    );
    
    if (newMessages.length < 20) {
      return; // Not enough new messages
    }
  }
  
  // Messages to summarize (exclude recent N)
  const toSummarize = messages.slice(0, -recentCount);
  
  // Generate summary using fast model
  const summary = await this.summarizeMessages(toSummarize);
  
  // Save summary
  await this.storage.saveSummary(chatId, {
    summary_text: summary,
    first_message_id: toSummarize[0].id,
    last_message_id: toSummarize[toSummarize.length - 1].id,
    message_count: toSummarize.length,
  });
  
  // Mark old messages as compressed
  await this.storage.markMessagesCompressed(
    toSummarize.map(m => m.id)
  );
  
  console.log(`✅ Summarized ${toSummarize.length} messages for chat ${chatId}`);
}

private async summarizeMessages(messages: any[]): Promise<string> {
  const summaryAgent = new Agent({
    model: 'openai/gpt-5.2-low', // Fast and cheap
    instructions: `Create a comprehensive summary of this conversation that preserves:

1. Main topics and decisions
2. Code examples and technical details (with specifics)
3. Tools used and their results
4. User's goals and context
5. Reasoning and thought processes
6. Any action items or next steps

Format as a clear, detailed summary that maintains continuity.`,
  });
  
  const conversationText = messages
    .map(m => {
      let text = `${m.role}: ${m.content}`;
      if (m.reasoning) text += `\n[Thinking: ${m.reasoning}]`;
      if (m.toolCalls) {
        text += `\n[Tools used: ${m.toolCalls.map(t => 
          `${t.toolName}(${JSON.stringify(t.args)}) → ${t.result?.slice(0, 100)}`
        ).join(', ')}]`;
      }
      return text;
    })
    .join('\n\n---\n\n');
  
  const result = await summaryAgent.generate(
    `Summarize this conversation:\n\n${conversationText}`
  );
  
  return result.text;
}
```

---

## Complete Storage Service

```typescript
// src/gateway/services/ChatStorageService.ts
import Database from 'better-sqlite3';

export class ChatStorageService {
  private db: Database.Database;
  
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initSchema();
  }
  
  async saveMessage(chatId: string, message: any) {
    const messageData = JSON.stringify(message);
    const tokens = this.estimateTokens(messageData);
    
    this.db.prepare(`
      INSERT INTO messages (id, chat_id, role, message_data, timestamp, token_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      message.id || this.generateId(),
      chatId,
      message.role,
      messageData,
      new Date().toISOString(),
      tokens
    );
    
    this.updateChatStats(chatId);
  }
  
  async loadAllMessages(chatId: string): Promise<any[]> {
    const rows = this.db.prepare(`
      SELECT message_data FROM messages 
      WHERE chat_id = ? 
      ORDER BY timestamp ASC
    `).all(chatId);
    
    return rows.map(row => JSON.parse(row.message_data));
  }
  
  async loadMessagesForLLM(chatId: string, recentCount = 10): Promise<any[]> {
    const allMessages = await this.loadAllMessages(chatId);
    
    if (allMessages.length <= recentCount) {
      return allMessages;
    }
    
    const summary = await this.getLatestSummary(chatId);
    const recentMessages = allMessages.slice(-recentCount);
    
    if (summary) {
      return [
        {
          role: 'system',
          content: `Previous conversation summary:\n\n${summary.summary_text}\n\nYou can search full history using the search_history tool.`,
        },
        ...recentMessages,
      ];
    }
    
    return recentMessages;
  }
  
  async saveSummary(chatId: string, summary: {
    summary_text: string;
    first_message_id: string;
    last_message_id: string;
    message_count: number;
  }) {
    const tokens = this.estimateTokens(summary.summary_text);
    
    this.db.prepare(`
      INSERT INTO chat_summaries 
      (chat_id, summary_text, first_message_id, last_message_id, message_count, created_at, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      chatId,
      summary.summary_text,
      summary.first_message_id,
      summary.last_message_id,
      summary.message_count,
      new Date().toISOString(),
      tokens
    );
  }
  
  async getLatestSummary(chatId: string) {
    return this.db.prepare(`
      SELECT * FROM chat_summaries 
      WHERE chat_id = ? 
      ORDER BY created_at DESC 
      LIMIT 1
    `).get(chatId);
  }
  
  async markMessagesCompressed(messageIds: string[]) {
    const stmt = this.db.prepare(`
      UPDATE messages SET is_compressed = 1 WHERE id = ?
    `);
    
    for (const id of messageIds) {
      stmt.run(id);
    }
  }
  
  private estimateTokens(text: string): number {
    return Math.ceil(text.length * 0.75);
  }
  
  private generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
  
  private updateChatStats(chatId: string) {
    const stats = this.db.prepare(`
      SELECT COUNT(*) as count, SUM(token_count) as tokens
      FROM messages WHERE chat_id = ?
    `).get(chatId);
    
    this.db.prepare(`
      UPDATE chats 
      SET message_count = ?, token_count = ?, updated_at = ?
      WHERE id = ?
    `).run(stats.count, stats.tokens, new Date().toISOString(), chatId);
  }
}
```

---

## Benefits of This Approach

✅ **Mastra does format conversion** - No manual adapters needed  
✅ **JSONB stores everything** - Complete message structure preserved  
✅ **Recent messages always full** - No information loss for current context  
✅ **Summaries for old context** - Save tokens, preserve essence  
✅ **Search tool for details** - LLM can dig deeper when needed  
✅ **Simple thresholds** - Summarize every 50 messages, not complex logic  
✅ **One source of truth** - SQLite with JSONB  

---

## Context Strategy Comparison

### Old (V1 Complex)
- Full history in `{id}.jsonl`
- Compressed in `{id}_llm.jsonl`
- Manual format translation
- Always load one or the other (all or nothing)

### New (V2 Simple)
```
LLM Context = Summary + Recent(10) + Search Tool

Example (50 messages total):
┌────────────────────────────────────────┐
│ System: "Summary of first 40 msgs..." │  ← Generated summary
├────────────────────────────────────────┤
│ Message 41 (full)                      │  ┐
│ Message 42 (full)                      │  │
│ Message 43 (full)                      │  ├─ Recent 10 (full detail)
│ ...                                    │  │
│ Message 50 (full)                      │  ┘
└────────────────────────────────────────┘
         +
┌────────────────────────────────────────┐
│ search_history tool (access all 50)   │  ← Tool to query full history
└────────────────────────────────────────┘
```

**Result**: Simple, effective, and LLM-friendly! 🚀
