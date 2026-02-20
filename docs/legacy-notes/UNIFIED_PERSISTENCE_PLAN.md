# Unified Chat Persistence - Local + PAPR Memory Compatible

## Key Insights from PAPR Memory API

### Message Format (PostMessage in Parse)
```json
{
  "message": "Text content",
  "content": [{"type": "text", "text": "..."}],  // Structured content
  "messageRole": "user" | "assistant",
  "processingStatus": "pending" | "stored_only" | "completed" | "failed",
  "chat": { /* Pointer to Chat */ },
  "user": { /* Pointer to _User */ }
}
```

### Summary Format (Chat.summaries in Parse)
```json
{
  "summaries": {
    "short_term": "Summary of last 15 messages",
    "medium_term": "Summary of last ~100 messages",
    "long_term": "Full session summary",
    "topics": ["topic1", "topic2"],
    "last_updated": "2026-02-10T..."
  }
}
```

**CRITICAL**: Only ONE summary object per chat (NOT versioned, gets replaced)

### API Endpoints
- `POST /v1/messages` - Store message
- `GET /v1/messages/sessions/{sessionId}` - Get history + summaries
- `GET /v1/messages/sessions/{sessionId}/compress` - Get/generate summaries
- `PATCH /v1/messages/sessions/{sessionId}` - Update title/metadata

---

## The 3-Mode Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    User Setting                              │
│  ☐ Local Only                                               │
│  ☑ Local + Sync to PAPR                                     │
│  ☐ PAPR Only (no local storage)                            │
└─────────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────┴─────────────────────────────────┐
│                 Storage Abstraction Layer                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  interface IStorageProvider {                       │   │
│  │    saveMessage(chatId, message)                     │   │
│  │    loadMessages(chatId)                             │   │
│  │    saveSummary(chatId, summary)                     │   │
│  │    getSummary(chatId)                               │   │
│  │  }                                                   │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────┬────────────────────────┬─────────────────────┘
             │                        │
   ┌─────────▼────────┐    ┌─────────▼──────────┐
   │ LocalStorageProvider│    │ PaprMemoryProvider│
   │ (SQLite + JSONB)   │    │ (HTTP API)        │
   └────────────────────┘    └───────────────────┘
```

---

## Unified Storage Schema (Local SQLite)

### Matches PAPR Memory Structure

```sql
-- Chats (matches Parse Chat class)
CREATE TABLE chats (
  id TEXT PRIMARY KEY,  -- sessionId
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_count INTEGER DEFAULT 0,
  
  -- Summary (same structure as PAPR Memory)
  summary_short TEXT,
  summary_medium TEXT,
  summary_long TEXT,
  summary_topics TEXT,  -- JSON array
  summary_last_updated TEXT,
  
  -- Sync status
  sync_status TEXT DEFAULT 'local',  -- 'local' | 'synced' | 'papr_only'
  last_synced_at TEXT,
  papr_chat_id TEXT  -- Parse objectId if synced
);

-- Messages (matches Parse PostMessage class)
CREATE TABLE messages (
  id TEXT PRIMARY KEY,  -- objectId if synced, or local ID
  chat_id TEXT NOT NULL,
  
  -- Message content (PAPR Memory format)
  message TEXT NOT NULL,  -- Plain text content
  content TEXT,  -- Structured content as JSON (Mastra format)
  message_role TEXT NOT NULL CHECK(message_role IN ('user', 'assistant')),
  
  -- Processing status (matches PAPR)
  processing_status TEXT DEFAULT 'stored_only',  -- 'pending' | 'stored_only' | 'completed' | 'failed'
  
  -- Metadata
  timestamp TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  
  -- Sync status
  sync_status TEXT DEFAULT 'local',
  papr_message_id TEXT,  -- Parse objectId if synced
  
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX idx_messages_chat_id ON messages(chat_id);
CREATE INDEX idx_messages_timestamp ON messages(chat_id, timestamp);
CREATE INDEX idx_messages_sync_status ON messages(sync_status);
```

---

## Storage Provider Interface

```typescript
// src/gateway/services/storage/IStorageProvider.ts

export interface StoredMessage {
  id: string;
  chat_id: string;
  message: string;  // Plain text
  content?: any;  // Structured (Mastra format)
  message_role: 'user' | 'assistant';
  timestamp: string;
  token_count?: number;
}

export interface StoredSummary {
  short_term: string;
  medium_term: string;
  long_term: string;
  topics: string[];
  last_updated: string;
}

export interface IStorageProvider {
  // Messages
  saveMessage(chatId: string, message: StoredMessage): Promise<void>;
  loadMessages(chatId: string, limit?: number, skip?: number): Promise<StoredMessage[]>;
  loadMessagesForLLM(chatId: string): Promise<any[]>;
  
  // Summaries
  saveSummary(chatId: string, summary: StoredSummary): Promise<void>;
  getSummary(chatId: string): Promise<StoredSummary | null>;
  
  // Chat metadata
  createChat(chatId: string, title?: string): Promise<void>;
  updateChat(chatId: string, updates: Partial<{ title: string }>): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  listChats(): Promise<Array<{ id: string; title: string; updated_at: string }>>;
}
```

---

## 1. Local Storage Provider (SQLite)

```typescript
// src/gateway/services/storage/LocalStorageProvider.ts
import Database from 'better-sqlite3';

export class LocalStorageProvider implements IStorageProvider {
  private db: Database.Database;
  
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initSchema();
  }
  
  async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
    this.db.prepare(`
      INSERT INTO messages (
        id, chat_id, message, content, message_role, 
        timestamp, token_count, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'local')
    `).run(
      message.id,
      chatId,
      message.message,
      message.content ? JSON.stringify(message.content) : null,
      message.message_role,
      message.timestamp,
      message.token_count || 0
    );
    
    // Update chat message count
    this.db.prepare(`
      UPDATE chats 
      SET message_count = message_count + 1, 
          updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), chatId);
  }
  
  async loadMessagesForLLM(chatId: string): Promise<any[]> {
    // Get summary
    const summaryRow = this.db.prepare(`
      SELECT summary_short, summary_medium, summary_long, summary_topics 
      FROM chats WHERE id = ?
    `).get(chatId);
    
    // Get recent messages (not compressed)
    const messageRows = this.db.prepare(`
      SELECT content FROM messages 
      WHERE chat_id = ? 
      ORDER BY timestamp ASC
    `).all(chatId);
    
    const messages = messageRows.map(row => JSON.parse(row.content));
    
    // If we have a summary, use recent messages only
    if (summaryRow?.summary_long) {
      const recentCount = 10;
      const recentMessages = messages.slice(-recentCount);
      
      return [
        {
          role: 'user',
          content: this.formatSummaryForLLM(summaryRow, messages.length, recentCount)
        },
        ...recentMessages
      ];
    }
    
    // No summary yet, return all messages
    return messages;
  }
  
  async saveSummary(chatId: string, summary: StoredSummary): Promise<void> {
    this.db.prepare(`
      UPDATE chats 
      SET summary_short = ?,
          summary_medium = ?,
          summary_long = ?,
          summary_topics = ?,
          summary_last_updated = ?
      WHERE id = ?
    `).run(
      summary.short_term,
      summary.medium_term,
      summary.long_term,
      JSON.stringify(summary.topics),
      summary.last_updated,
      chatId
    );
  }
  
  private formatSummaryForLLM(summary: any, totalMessages: number, recentCount: number): string {
    return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 CONVERSATION SUMMARY (${totalMessages - recentCount} messages archived)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️  IMPORTANT: DO NOT respond to this summary. Focus on the ${recentCount} recent messages below.

───────────────────────────────────────────────────────────

FULL SESSION: ${summary.summary_long}

RECENT CONTEXT (last ~100): ${summary.summary_medium}

CURRENT BATCH (last 15): ${summary.summary_short}

KEY TOPICS: ${JSON.parse(summary.summary_topics || '[]').join(', ')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[END OF ARCHIVED CONTEXT]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The following ${recentCount} messages are the RECENT conversation.`;
  }
}
```

---

## 2. PAPR Memory Provider (HTTP API)

```typescript
// src/gateway/services/storage/PaprMemoryProvider.ts
import axios from 'axios';

export class PaprMemoryProvider implements IStorageProvider {
  private apiUrl: string;
  private apiKey: string;
  private bearerToken: string;
  
  constructor(config: { apiUrl: string; apiKey: string; bearerToken: string }) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.bearerToken = config.bearerToken;
  }
  
  async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
    await axios.post(
      `${this.apiUrl}/v1/messages`,
      {
        content: message.content || message.message,
        role: message.message_role,
        sessionId: chatId,
        process_messages: false,  // Don't process into memories (just store)
      },
      {
        headers: {
          'X-API-Key': this.apiKey,
          'Authorization': `Bearer ${this.bearerToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
  }
  
  async loadMessages(chatId: string, limit = 100, skip = 0): Promise<StoredMessage[]> {
    const response = await axios.get(
      `${this.apiUrl}/v1/messages/sessions/${chatId}`,
      {
        headers: {
          'X-API-Key': this.apiKey,
          'Authorization': `Bearer ${this.bearerToken}`,
        },
        params: { limit, skip },
      }
    );
    
    return response.data.messages.map((msg: any) => ({
      id: msg.objectId,
      chat_id: chatId,
      message: typeof msg.content === 'string' ? msg.content : '',
      content: msg.content,
      message_role: msg.role,
      timestamp: msg.createdAt,
    }));
  }
  
  async loadMessagesForLLM(chatId: string): Promise<any[]> {
    const response = await axios.get(
      `${this.apiUrl}/v1/messages/sessions/${chatId}`,
      {
        headers: {
          'X-API-Key': this.apiKey,
          'Authorization': `Bearer ${this.bearerToken}`,
        },
      }
    );
    
    // PAPR Memory returns context_for_llm pre-formatted
    if (response.data.context_for_llm) {
      // Parse the formatted context or use summaries + recent messages
      const summary = response.data.summaries;
      const recentMessages = response.data.messages.slice(-10);
      
      return [
        {
          role: 'user',
          content: this.formatSummaryForLLM(summary, response.data.total_count, recentMessages.length)
        },
        ...recentMessages.map((m: any) => ({
          role: m.role,
          content: m.content
        }))
      ];
    }
    
    // No summary, return all messages
    return response.data.messages.map((m: any) => ({
      role: m.role,
      content: m.content
    }));
  }
  
  async getSummary(chatId: string): Promise<StoredSummary | null> {
    const response = await axios.get(
      `${this.apiUrl}/v1/messages/sessions/${chatId}/compress`,
      {
        headers: {
          'X-API-Key': this.apiKey,
          'Authorization': `Bearer ${this.bearerToken}`,
        },
      }
    );
    
    if (response.data.summaries) {
      return {
        short_term: response.data.summaries.short_term,
        medium_term: response.data.summaries.medium_term,
        long_term: response.data.summaries.long_term,
        topics: response.data.summaries.topics,
        last_updated: response.data.summaries.last_updated,
      };
    }
    
    return null;
  }
}
```

---

## 3. Hybrid Storage Provider (Local + Sync)

```typescript
// src/gateway/services/storage/HybridStorageProvider.ts

export class HybridStorageProvider implements IStorageProvider {
  private local: LocalStorageProvider;
  private papr: PaprMemoryProvider;
  private syncEnabled: boolean;
  
  constructor(localPath: string, paprConfig: any) {
    this.local = new LocalStorageProvider(localPath);
    this.papr = new PaprMemoryProvider(paprConfig);
    this.syncEnabled = true;
  }
  
  async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
    // ALWAYS save locally first
    await this.local.saveMessage(chatId, message);
    
    // Sync to PAPR if enabled
    if (this.syncEnabled) {
      try {
        await this.papr.saveMessage(chatId, message);
        
        // Mark as synced
        await this.local.markMessageSynced(message.id);
      } catch (error) {
        console.error('Failed to sync message to PAPR:', error);
        // Continue - message is safe locally
      }
    }
  }
  
  async loadMessagesForLLM(chatId: string): Promise<any[]> {
    // Prefer PAPR if synced (has better summaries)
    if (this.syncEnabled) {
      try {
        const paprMessages = await this.papr.loadMessagesForLLM(chatId);
        if (paprMessages.length > 0) {
          return paprMessages;  // PAPR has data
        }
      } catch (error) {
        console.error('Failed to load from PAPR, using local:', error);
      }
    }
    
    // Fallback to local
    return await this.local.loadMessagesForLLM(chatId);
  }
  
  async saveSummary(chatId: string, summary: StoredSummary): Promise<void> {
    // Save locally
    await this.local.saveSummary(chatId, summary);
    
    // Sync to PAPR (summaries are in Chat class, not separate)
    if (this.syncEnabled) {
      try {
        // Update Chat.summaries via PATCH endpoint
        await this.papr.updateChatSummary(chatId, summary);
      } catch (error) {
        console.error('Failed to sync summary to PAPR:', error);
      }
    }
  }
}
```

---

## 4. Storage Manager (User Setting)

```typescript
// src/gateway/services/storage/StorageManager.ts

export type StorageMode = 'local' | 'local+papr' | 'papr';

export class StorageManager {
  private provider: IStorageProvider;
  
  constructor(mode: StorageMode, localPath: string, paprConfig?: any) {
    switch (mode) {
      case 'local':
        this.provider = new LocalStorageProvider(localPath);
        break;
        
      case 'local+papr':
        if (!paprConfig) throw new Error('PAPR config required for hybrid mode');
        this.provider = new HybridStorageProvider(localPath, paprConfig);
        break;
        
      case 'papr':
        if (!paprConfig) throw new Error('PAPR config required for PAPR-only mode');
        this.provider = new PaprMemoryProvider(paprConfig);
        break;
    }
  }
  
  // Delegate all methods to provider
  async saveMessage(chatId: string, message: StoredMessage) {
    return this.provider.saveMessage(chatId, message);
  }
  
  async loadMessagesForLLM(chatId: string) {
    return this.provider.loadMessagesForLLM(chatId);
  }
  
  // ... other methods
}
```

---

## 5. Summary Format (Compatible with PAPR)

### PAPR Memory Summary Structure

```json
{
  "short_term": "Summary of last 15 messages",
  "medium_term": "Summary of last ~100 messages",
  "long_term": "Full session summary",
  "topics": ["planning", "product", "roadmap"],
  "last_updated": "2026-02-10T..."
}
```

**Note**: PAPR doesn't version summaries - just replaces them!

### V2 Approach: NO VERSIONING (Match PAPR)

```typescript
// When summarizing
async summarize(chatId: string) {
  const messages = await storage.loadAllMessages(chatId);
  
  // Generate summary (existing code from V1)
  const summary = await generateSummary(messages);
  
  // REPLACE existing summary (no versioning)
  await storage.saveSummary(chatId, {
    short_term: summary.short_term,
    medium_term: summary.medium_term,
    long_term: summary.long_term,
    topics: summary.topics,
    last_updated: new Date().toISOString(),
  });
}
```

**No history tracking** - summary gets replaced each time (matches PAPR)

---

## 6. Settings UI

```typescript
// In Settings
interface ChatStorageSettings {
  mode: 'local' | 'local+papr' | 'papr';
  paprApiUrl?: string;
  paprApiKey?: string;
}

// User can toggle
<select value={settings.mode} onChange={handleModeChange}>
  <option value="local">Local Only (SQLite)</option>
  <option value="local+papr">Local + Sync to PAPR Memory</option>
  <option value="papr">PAPR Memory Only (Cloud)</option>
</select>
```

---

## 7. Complete Flow Example

### Mode: Local + Sync

**User sends message:**
```
1. Save to SQLite (immediate)
   ↓
2. Sync to PAPR API (background)
   POST /v1/messages
   ↓
3. Mark as synced in SQLite
```

**Load for LLM:**
```
1. Try PAPR first (has summaries)
   GET /v1/messages/sessions/{id}
   ↓
2. If PAPR fails → fallback to local SQLite
   ↓
3. Format with summary + recent messages
```

**Summarization (every 50 messages):**
```
1. Generate summary locally
   ↓
2. Save to SQLite
   ↓
3. Sync to PAPR (if enabled)
   - PAPR will update Chat.summaries
   - Replaces existing (no versioning)
```

---

## 8. Migration Strategy

### From V1 JSONL to V2 SQLite + PAPR

```typescript
async function migrateV1ToV2(userId: string) {
  // 1. Read V1 JSONL files
  const v1Chats = await readV1Chats();
  
  for (const chat of v1Chats) {
    // 2. Save to local SQLite
    for (const message of chat.messages) {
      await local.saveMessage(chat.id, transformV1Message(message));
    }
    
    // 3. Optionally sync to PAPR
    if (settings.mode === 'local+papr') {
      for (const message of chat.messages) {
        await papr.saveMessage(chat.id, transformV1Message(message));
      }
    }
  }
}
```

---

## Key Design Decisions

### ✅ NO Versioning (Match PAPR)
- Summaries get **replaced**, not versioned
- Simpler, matches PAPR Memory exactly
- Full message history still available for regeneration

### ✅ Three Storage Modes
- **Local**: Fast, offline, private
- **Local + PAPR**: Best of both (fast local + cloud backup)
- **PAPR Only**: Cloud-first, cross-device

### ✅ Compatible Format
- Messages use PAPR's structure (message, content, messageRole)
- Summaries use PAPR's structure (short/medium/long + topics)
- Easy to sync back and forth

### ✅ Sync Strategy
- Local-first (always save locally first)
- Background sync to PAPR
- Fallback to local if PAPR unavailable
- Track sync status per message

---

## Benefits

✅ **Flexible**: User chooses local vs cloud  
✅ **Compatible**: Same format as PAPR Memory  
✅ **Resilient**: Local fallback if PAPR unavailable  
✅ **Fast**: Local SQLite for instant responses  
✅ **Synced**: Cloud backup and cross-device  
✅ **Simple**: No versioning, just replace summaries  

---

## Implementation Phases

### Phase 1: Local Storage (Week 1)
- SQLite schema matching PAPR format
- LocalStorageProvider implementation
- Basic save/load functionality

### Phase 2: PAPR Integration (Week 2)
- PaprMemoryProvider implementation
- HybridStorageProvider for sync
- Settings UI for mode selection

### Phase 3: Summarization (Week 3)
- Generate PAPR-compatible summaries
- Sync summaries to PAPR
- Handle summary updates

### Phase 4: Migration (Week 4)
- V1 JSONL → V2 SQLite migration
- Bulk sync to PAPR
- Testing and validation

**Result**: Unified persistence that works locally, with PAPR, or both! 🚀
