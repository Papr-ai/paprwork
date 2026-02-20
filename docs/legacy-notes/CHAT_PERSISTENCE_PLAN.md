# Chat Persistence Implementation Plan - Paprwork v2

## The Simple, Right Way™

Based on research of OpenClaw, Claude's compaction system, v1's issues, and industry best practices.

---

## Core Principles

1. ✅ **One storage system**: SQLite (not JSONL)
2. ✅ **One write path**: Gateway only (not main + renderer)
3. ✅ **One source of truth**: Database (not dual files)
4. ✅ **Smart compaction**: Background service at 60% threshold
5. ✅ **Visible context**: Show % usage to users

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         UI Layer                             │
│  - Display messages (paginated)                              │
│  - Show context usage: "Context: 45% ⚡"                     │
│  - Trigger manual compaction                                 │
└─────────────────────────────┬───────────────────────────────┘
                              │ IPC
┌─────────────────────────────┴───────────────────────────────┐
│                      Electron Main                           │
│  - IPC handlers (chat.load, chat.save)                       │
│  - Forward to Gateway                                        │
└─────────────────────────────┬───────────────────────────────┘
                              │ HTTP/WebSocket
┌─────────────────────────────┴───────────────────────────────┐
│                    Gateway (Node.js)                         │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ AgentService.stream()                               │    │
│  │  - Receive chunks from MastraAgent                  │    │
│  │  - Save messages to SQLite                          │    │
│  │  - Update context usage                             │    │
│  │  - Trigger compaction if > 60%                      │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ CompactionService (Background)                      │    │
│  │  - Summarize old messages                           │    │
│  │  - Save compressed context                          │    │
│  │  - Keep full history in DB                          │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ ChatStorageService (SQLite)                         │    │
│  │  - messages table (full history)                    │    │
│  │  - compressed_context table (summaries)             │    │
│  │  - chats table (metadata)                           │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Core Persistence (This Week)

### 1.1 Setup SQLite Database

**File**: `src/gateway/services/ChatStorageService.ts`

```typescript
import Database from 'better-sqlite3';
import path from 'path';

export class ChatStorageService {
  private db: Database.Database;
  
  constructor(userDataPath: string) {
    const dbPath = path.join(userDataPath, 'chats.db');
    this.db = new Database(dbPath);
    this.initSchema();
  }
  
  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        summary TEXT,
        context_tokens INTEGER DEFAULT 0,
        context_pct REAL DEFAULT 0,
        last_compaction_at TEXT
      );
      
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
        content TEXT NOT NULL,
        reasoning TEXT,
        tool_calls TEXT,  -- JSON array
        timestamp TEXT NOT NULL,
        token_count INTEGER DEFAULT 0,
        is_compressed INTEGER DEFAULT 0,  -- Boolean
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id 
        ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp 
        ON messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_compressed 
        ON messages(chat_id, is_compressed);
      
      CREATE TABLE IF NOT EXISTS compressed_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        message_range TEXT NOT NULL,  -- "msg_1 to msg_50"
        compressed_at TEXT NOT NULL,
        token_count INTEGER DEFAULT 0,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_compressed_chat_id 
        ON compressed_context(chat_id);
    `);
  }
  
  // Save a message
  async saveMessage(chatId: string, message: CoreMessage) {
    const tokens = this.estimateTokens(message.content);
    
    this.db.prepare(`
      INSERT INTO messages (id, chat_id, role, content, reasoning, tool_calls, timestamp, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      chatId,
      message.role,
      message.content,
      message.reasoning || null,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      new Date().toISOString(),
      tokens
    );
    
    // Update chat metadata
    this.updateChatMetadata(chatId);
  }
  
  // Load messages for UI (paginated)
  async loadMessages(chatId: string, limit = 100, offset = 0) {
    const rows = this.db.prepare(`
      SELECT * FROM messages 
      WHERE chat_id = ? 
      ORDER BY timestamp ASC
      LIMIT ? OFFSET ?
    `).all(chatId, limit, offset);
    
    return rows.map(row => ({
      id: row.id,
      role: row.role,
      content: row.content,
      reasoning: row.reasoning,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      timestamp: row.timestamp,
    }));
  }
  
  // Load messages for LLM (with compaction)
  async loadMessagesForLLM(chatId: string, maxTokens = 100000) {
    // Check if we have compressed context
    const compressed = this.db.prepare(`
      SELECT * FROM compressed_context 
      WHERE chat_id = ? 
      ORDER BY compressed_at DESC 
      LIMIT 1
    `).get(chatId);
    
    if (compressed) {
      // Return compressed summary + recent messages
      const recentMessages = this.db.prepare(`
        SELECT * FROM messages 
        WHERE chat_id = ? AND is_compressed = 0
        ORDER BY timestamp ASC
      `).all(chatId);
      
      return [
        {
          role: 'system',
          content: `Previous conversation summary:\n\n${compressed.summary}`
        },
        ...recentMessages.map(this.rowToMessage)
      ];
    }
    
    // No compression yet, return all messages (with limit check)
    const messages = this.db.prepare(`
      SELECT * FROM messages 
      WHERE chat_id = ? 
      ORDER BY timestamp ASC
    `).all(chatId);
    
    return messages.map(this.rowToMessage);
  }
  
  private updateChatMetadata(chatId: string) {
    // Count messages and tokens
    const stats = this.db.prepare(`
      SELECT COUNT(*) as count, SUM(token_count) as tokens
      FROM messages WHERE chat_id = ?
    `).get(chatId);
    
    const contextPct = (stats.tokens / 200000) * 100; // Assuming 200K context window
    
    this.db.prepare(`
      UPDATE chats 
      SET message_count = ?, 
          context_tokens = ?,
          context_pct = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      stats.count,
      stats.tokens,
      contextPct,
      new Date().toISOString(),
      chatId
    );
    
    return { count: stats.count, tokens: stats.tokens, contextPct };
  }
  
  private estimateTokens(content: string): number {
    // Rough estimate: ~0.75 tokens per character
    return Math.ceil(content.length * 0.75);
  }
  
  private rowToMessage(row: any) {
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      reasoning: row.reasoning,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      timestamp: row.timestamp,
    };
  }
}
```

### 1.2 Update AgentService

**File**: `src/gateway/services/AgentService.ts`

```typescript
import { ChatStorageService } from './ChatStorageService.js';

export class AgentService {
  private storage: ChatStorageService;
  
  constructor(userDataPath: string) {
    this.storage = new ChatStorageService(userDataPath);
  }
  
  async *streamAgent(chatId: string, message: string, config: AgentConfig) {
    // Save user message
    await this.storage.saveMessage(chatId, {
      role: 'user',
      content: message,
    });
    
    // Load history for LLM
    const history = await this.storage.loadMessagesForLLM(chatId);
    
    // Stream from Mastra
    let assistantMessage = '';
    let reasoning = '';
    let toolCalls = [];
    
    for await (const chunk of this.mastraAgent.stream(chatId, message, config)) {
      yield chunk; // Stream to client
      
      // Accumulate content
      if (chunk.type === 'text-delta') {
        assistantMessage += chunk.payload.text;
      } else if (chunk.type === 'reasoning-delta') {
        reasoning += chunk.payload.text;
      } else if (chunk.type === 'tool-call') {
        toolCalls.push(chunk.payload);
      } else if (chunk.type === 'done') {
        // Save assistant message
        await this.storage.saveMessage(chatId, {
          role: 'assistant',
          content: assistantMessage,
          reasoning: reasoning || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
        
        // Check if compaction needed
        const stats = await this.storage.getChatStats(chatId);
        if (stats.contextPct > 60) {
          // Trigger background compaction
          this.compactionService.scheduleCompaction(chatId);
        }
      }
    }
  }
}
```

### 1.3 Update Electron IPC

**File**: `src/electron/ipc/chat.ts`

```typescript
import { ipcMain } from 'electron';

export function registerChatHandlers(gateway: GatewayClient) {
  ipcMain.handle('chat:load', async (event, chatId: string) => {
    // Forward to gateway
    return await gateway.loadChat(chatId);
  });
  
  ipcMain.handle('chat:list', async () => {
    return await gateway.listChats();
  });
  
  ipcMain.handle('chat:create', async () => {
    return await gateway.createChat();
  });
  
  ipcMain.handle('chat:delete', async (event, chatId: string) => {
    return await gateway.deleteChat(chatId);
  });
}
```

### 1.4 Update UI Hook

**File**: `ui/hooks/useChat.ts`

```typescript
export function useChat() {
  const { activeChat, messages, setMessages } = useChatStore();
  
  // Load chat history when activeChat changes
  useEffect(() => {
    if (activeChat && window.electronAPI?.chat) {
      window.electronAPI.chat.load(activeChat)
        .then(messages => {
          setMessages(messages);
        })
        .catch(err => {
          console.error('Failed to load chat:', err);
        });
    }
  }, [activeChat]);
  
  // ... rest of hook
}
```

---

## Phase 2: Compaction Service (Next Week)

### 2.1 Create CompactionService

**File**: `src/gateway/services/CompactionService.ts`

```typescript
import { ChatStorageService } from './ChatStorageService.js';
import { Agent } from '@mastra/core/agent';

export class CompactionService {
  private storage: ChatStorageService;
  private queue: Set<string> = new Set();
  
  constructor(storage: ChatStorageService) {
    this.storage = storage;
  }
  
  scheduleCompaction(chatId: string) {
    this.queue.add(chatId);
    // Debounce: run after 5 seconds of inactivity
    setTimeout(() => this.processQueue(), 5000);
  }
  
  private async processQueue() {
    for (const chatId of this.queue) {
      await this.compactChat(chatId);
      this.queue.delete(chatId);
    }
  }
  
  async compactChat(chatId: string) {
    console.log(`🗜️ Compacting chat ${chatId}...`);
    
    // 1. Get messages to compress (all except last 20)
    const allMessages = await this.storage.loadAllMessages(chatId);
    const recentCount = 20;
    const oldMessages = allMessages.slice(0, -recentCount);
    
    if (oldMessages.length < 10) {
      console.log('Not enough messages to compress');
      return;
    }
    
    // 2. Generate summary using fast model
    const summary = await this.generateSummary(oldMessages);
    
    // 3. Save compressed context
    await this.storage.saveCompressedContext(chatId, {
      summary,
      messageRange: `${oldMessages[0].id} to ${oldMessages[oldMessages.length - 1].id}`,
      messageCount: oldMessages.length,
    });
    
    // 4. Mark old messages as compressed
    await this.storage.markMessagesCompressed(oldMessages.map(m => m.id));
    
    console.log(`✅ Compressed ${oldMessages.length} messages`);
  }
  
  private async generateSummary(messages: CoreMessage[]): Promise<string> {
    // Use fast model for summarization
    const agent = new Agent({
      model: 'openai/gpt-5.2-low',  // or 'anthropic/claude-haiku-4-5'
      instructions: `Summarize this conversation concisely, preserving:
- Key decisions and conclusions
- Important code or technical details
- User's goals and preferences
- Critical context for future messages

Aim for 30% of original length.`,
    });
    
    const conversationText = messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n');
    
    const result = await agent.generate(
      `Summarize this conversation:\n\n${conversationText}`
    );
    
    return result.text;
  }
}
```

---

## Phase 3: UI Enhancements

### 3.1 Context Usage Indicator

**File**: `ui/components/Chat/ContextIndicator.tsx`

```tsx
export const ContextIndicator: React.FC<{ chatId: string }> = ({ chatId }) => {
  const [contextPct, setContextPct] = useState(0);
  
  useEffect(() => {
    // Load context percentage from backend
    window.electronAPI.chat.getStats(chatId).then(stats => {
      setContextPct(stats.contextPct);
    });
  }, [chatId]);
  
  const getColor = () => {
    if (contextPct < 50) return '#10b981'; // green
    if (contextPct < 70) return '#f59e0b'; // yellow
    return '#ef4444'; // red
  };
  
  return (
    <div className="context-indicator" style={{ color: getColor() }}>
      <span>Context: {contextPct.toFixed(0)}%</span>
      {contextPct > 70 && <span> ⚠️ Consider starting new chat</span>}
    </div>
  );
};
```

---

## Migration Strategy (Optional)

For users with v1 data:

```typescript
async function migrateFromV1() {
  const v1ChatsDir = path.join(app.getPath('userData'), 'chats');
  const v1Index = JSON.parse(await fs.readFile(path.join(v1ChatsDir, 'index.json')));
  
  for (const chat of v1Index.chats) {
    // Read v1 JSONL
    const v1Messages = await readV1JSONL(path.join(v1ChatsDir, `${chat.id}.jsonl`));
    
    // Create chat in v2
    await storage.createChat(chat.id, chat.title);
    
    // Insert messages
    for (const msg of v1Messages) {
      await storage.saveMessage(chat.id, transformV1Message(msg));
    }
  }
}
```

---

## Testing Checklist

- [ ] Create new chat
- [ ] Send message → saved to SQLite
- [ ] Reload app → messages persist
- [ ] Switch chats → messages load correctly
- [ ] Send 100+ messages → auto-compaction triggers
- [ ] Context indicator updates in real-time
- [ ] Delete chat → messages cascade delete
- [ ] Export chat history
- [ ] Search messages (future)

---

## Performance Targets

- **Save message**: < 10ms
- **Load 100 messages**: < 50ms
- **Compaction**: < 5s (background, non-blocking)
- **Context calculation**: < 1ms (cached)

---

## Summary

**Simple = Reliable:**
- ✅ One file (SQLite), not two (JSONL + _llm)
- ✅ One path (Gateway), not two (main + renderer)
- ✅ One service (Compaction), not three (manual + auto + callback)
- ✅ Visible (context %), not hidden (surprise compaction)

**Result:** Clean, maintainable chat persistence that just works! 🚀
