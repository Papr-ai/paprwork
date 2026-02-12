# PAPR Memory Schema vs Local SQLite Schema

## Parse Server Schema (PAPR Memory)

### Chat Class - The Container

Think of this as a **conversation session**. Each chat is like a "thread" or "conversation".

```python
class Chat:
    # Identity
    objectId: str                    # Unique Parse ID
    sessionId: str                   # User-friendly session ID
    title: str                       # "Q4 Planning Session"
    
    # Timestamps
    createdAt: datetime
    updatedAt: datetime
    
    # Message tracking
    messageCount: int                # Total messages in this chat
    lastProcessedMessageIndex: int   # For batch processing
    
    # Processing status
    processingStatus: str            # "active" | "processing" | "completed" | "archived"
    lastProcessedAt: datetime
    lastProcessedMessage: Pointer    # -> PostMessage
    
    # Summaries (stored as nested object)
    summaries: {
        "short_term": "Last 15 messages summary",
        "medium_term": "Last ~100 messages summary", 
        "long_term": "Full conversation summary",
        "topics": ["planning", "product", "Q4"],
        "last_updated": "2026-02-10T..."
    }
    
    # Relationships
    user: Pointer                    # -> _User
    workspace: Pointer               # -> WorkSpace
    organization: Pointer            # -> Organization (multi-tenant)
    namespace: Pointer               # -> Namespace (multi-tenant)
    
    # Metadata
    metadata: dict                   # Extra custom data
```

**Key Points:**
- ONE Chat per conversation
- Contains aggregate data (message count, summaries)
- NO message content stored here
- Summaries get REPLACED when updated (not versioned)

---

### PostMessage Class - The Individual Messages

Each message (user or assistant) is a separate PostMessage record.

```python
class PostMessage:
    # Identity
    objectId: str                    # Unique Parse ID
    
    # Timestamps
    createdAt: datetime
    updatedAt: datetime
    
    # Message content
    message: str                     # Plain text content
    content: str                     # Structured content (JSON string)
    messageRole: str                 # "user" | "assistant"
    assistantResponse: str           # For assistant messages
    title: str                       # Optional message title
    
    # AI/LLM metadata
    model: str                       # "gpt-5.2" | "claude-4.5-sonnet"
    promptTokens: int
    completionTokens: int
    inputCosts: float
    outputCosts: float
    totalCosts: float
    
    # Processing status
    processingStatus: str            # "pending" | "stored_only" | "completed" | "failed"
    processingError: str
    processingAttempts: int
    
    # Content extras
    highlightedText: str
    imageUrls: list[str]
    
    # Relationships
    user: Pointer                    # -> _User
    chat: Pointer                    # -> Chat (PARENT)
    workspace: Pointer               # -> WorkSpace
    organization: Pointer            # -> Organization
    namespace: Pointer               # -> Namespace
    
    # Message threading
    parentPostMessage: Pointer       # For nested replies
    replyToUserPostMessage: Pointer
    childPostMessageCount: int
    
    # Memory integration
    memoriesUsed: list[Pointer]      # -> Memory nodes created/used
```

**Key Points:**
- ONE PostMessage per message (user or assistant)
- Belongs to a Chat (via `chat` pointer)
- Contains all message content and metadata
- Can be processed into memories

---

## Relationship Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         Chat                                │
│  - objectId: "chat_abc123"                                  │
│  - sessionId: "session_2024_q4"                             │
│  - title: "Q4 Planning Session"                             │
│  - messageCount: 45                                         │
│  - summaries: { short_term, medium_term, long_term }        │
│  - user: -> _User                                           │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │
                            │ chat pointer
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        │                   │                   │
┌───────▼────────┐  ┌───────▼────────┐  ┌──────▼─────────┐
│  PostMessage   │  │  PostMessage   │  │  PostMessage   │
│  - objectId: 1 │  │  - objectId: 2 │  │  - objectId: 3 │
│  - message: "..│  │  - message: "..│  │  - message: "..│
│  - role: user  │  │  - role: asst  │  │  - role: user  │
│  - chat: ────►Chat│  - chat: ────►Chat│  - chat: ────►Chat
└────────────────┘  └────────────────┘  └────────────────┘
```

**It's a 1-to-many relationship:**
- 1 Chat → Many PostMessages
- Each PostMessage belongs to 1 Chat

---

## Why Two Tables?

### ❌ BAD: Store everything in one table
```sql
CREATE TABLE messages (
  id TEXT,
  message TEXT,
  role TEXT,
  -- Also store session metadata here? Duplicate for each message!
  session_title TEXT,      -- DUPLICATED 45 times!
  summary_short TEXT,       -- DUPLICATED 45 times!
  summary_medium TEXT,      -- DUPLICATED 45 times!
  summary_long TEXT,        -- DUPLICATED 45 times!
  ...
)
```
**Problems:**
- Massive data duplication (summaries repeated for every message)
- Hard to update session metadata (need to update 45 rows!)
- Poor performance (huge rows)
- Wastes storage

### ✅ GOOD: Normalized design with two tables

```sql
-- Chats: Session-level data (ONE per conversation)
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  title TEXT,
  message_count INTEGER,
  summary_short TEXT,
  summary_medium TEXT,
  summary_long TEXT,
  summary_topics TEXT,  -- JSON array
  ...
);

-- Messages: Individual messages (MANY per conversation)
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT,           -- Foreign key to chats
  message TEXT,
  content TEXT,           -- JSONB for structured content
  message_role TEXT,
  timestamp TEXT,
  ...
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);
```

**Benefits:**
- ✅ No data duplication
- ✅ Update chat metadata once (affects all messages)
- ✅ Better performance (smaller rows)
- ✅ Matches PAPR Memory structure exactly
- ✅ Easy to sync with PAPR API

---

## Local SQLite Schema (Matches PAPR)

### `chats` Table - Matches Parse `Chat` class

```sql
CREATE TABLE chats (
  -- Identity (matches PAPR)
  id TEXT PRIMARY KEY,              -- sessionId (local) or Parse objectId (if synced)
  title TEXT,
  
  -- Timestamps
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  
  -- Message tracking (matches PAPR)
  message_count INTEGER DEFAULT 0,
  last_processed_message_index INTEGER DEFAULT 0,
  
  -- Processing status (matches PAPR)
  processing_status TEXT DEFAULT 'active',  -- 'active' | 'processing' | 'completed' | 'archived'
  last_processed_at TEXT,
  
  -- Summaries (matches PAPR format)
  summary_short TEXT,               -- summaries.short_term
  summary_medium TEXT,              -- summaries.medium_term
  summary_long TEXT,                -- summaries.long_term
  summary_topics TEXT,              -- summaries.topics (JSON array)
  summary_last_updated TEXT,        -- summaries.last_updated
  
  -- Sync tracking
  sync_status TEXT DEFAULT 'local', -- 'local' | 'synced' | 'papr_only'
  last_synced_at TEXT,
  papr_object_id TEXT               -- Parse objectId if synced to PAPR
);
```

### `messages` Table - Matches Parse `PostMessage` class

```sql
CREATE TABLE messages (
  -- Identity (matches PAPR)
  id TEXT PRIMARY KEY,              -- Local ID or Parse objectId (if synced)
  chat_id TEXT NOT NULL,            -- Foreign key to chats.id
  
  -- Timestamps
  timestamp TEXT NOT NULL,
  
  -- Message content (matches PAPR)
  message TEXT NOT NULL,            -- Plain text content
  content TEXT,                     -- Structured content (JSONB in Mastra format)
  message_role TEXT NOT NULL CHECK(message_role IN ('user', 'assistant')),
  
  -- AI/LLM metadata (matches PAPR)
  model TEXT,                       -- "gpt-5.2" | "claude-4.5-sonnet"
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  
  -- Processing status (matches PAPR)
  processing_status TEXT DEFAULT 'stored_only',  -- 'pending' | 'stored_only' | 'completed' | 'failed'
  processing_error TEXT,
  processing_attempts INTEGER DEFAULT 0,
  
  -- Sync tracking
  sync_status TEXT DEFAULT 'local', -- 'local' | 'synced' | 'papr_only'
  papr_object_id TEXT,              -- Parse objectId if synced
  
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_chat_id ON messages(chat_id);
CREATE INDEX idx_messages_timestamp ON messages(chat_id, timestamp);
CREATE INDEX idx_messages_sync_status ON messages(sync_status);
```

---

## Data Flow Examples

### Example 1: User sends message (Local + Sync mode)

```typescript
// 1. Create chat if needed
await storageProvider.createChat('session_123', 'Q4 Planning');

// Chat table:
// id: 'session_123'
// title: 'Q4 Planning'
// message_count: 0
// sync_status: 'local'

// 2. Save message locally
await storageProvider.saveMessage('session_123', {
  id: 'msg_1',
  message: 'Let\'s plan Q4',
  message_role: 'user',
  content: [{ type: 'text', text: 'Let\'s plan Q4' }],
  timestamp: '2026-02-10T10:00:00Z'
});

// Messages table:
// id: 'msg_1'
// chat_id: 'session_123'  ← Links to chat
// message: 'Let\'s plan Q4'
// message_role: 'user'
// sync_status: 'local'

// Chat table updated:
// message_count: 1

// 3. Sync to PAPR (background)
// POST /v1/messages
//   sessionId: 'session_123'
//   content: [{ type: 'text', text: 'Let\'s plan Q4' }]
//   role: 'user'

// 4. Mark as synced
// Messages table:
// sync_status: 'synced'
// papr_object_id: 'abc123'  ← Parse objectId
```

### Example 2: Load conversation for LLM

```typescript
// 1. Get chat metadata
const chat = await db.prepare('SELECT * FROM chats WHERE id = ?').get('session_123');

// 2. Check if we have summaries
if (chat.summary_long) {
  // 3. Get recent messages only (last 10)
  const recentMessages = await db.prepare(`
    SELECT content FROM messages 
    WHERE chat_id = ? 
    ORDER BY timestamp DESC 
    LIMIT 10
  `).all('session_123');
  
  // 4. Format context for LLM
  return [
    {
      role: 'user',
      content: `
        CONVERSATION SUMMARY (35 older messages):
        Full: ${chat.summary_long}
        Recent: ${chat.summary_medium}
        Current: ${chat.summary_short}
        Topics: ${JSON.parse(chat.summary_topics).join(', ')}
        
        [Recent 10 messages follow...]
      `
    },
    ...recentMessages
  ];
}

// No summary yet, return all messages
const allMessages = await db.prepare(`
  SELECT content FROM messages 
  WHERE chat_id = ? 
  ORDER BY timestamp ASC
`).all('session_123');
```

### Example 3: Summarize conversation

```typescript
// After 50 messages, trigger summarization

// 1. Load all messages for this chat
const messages = await db.prepare(`
  SELECT message, message_role, timestamp 
  FROM messages 
  WHERE chat_id = ? 
  ORDER BY timestamp ASC
`).all('session_123');

// 2. Generate summary (using LLM)
const summary = await generateSummary(messages);

// 3. Update chat table (ONE update, affects all messages)
await db.prepare(`
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
  new Date().toISOString(),
  'session_123'
);

// 4. Sync to PAPR (if enabled)
// The summary goes into Chat.summaries field in Parse
```

---

## Summary

### Do we need both tables locally?

**YES! Absolutely!**

1. **`chats`** - Container for conversation
   - Session metadata (title, message count)
   - Summaries (shared across all messages)
   - Processing status
   - One record per conversation

2. **`messages`** - Individual messages
   - Message content (user/assistant)
   - Token counts, model info
   - Processing status per message
   - Many records per conversation

### Why this design?

✅ **Matches PAPR Memory** - Easy to sync  
✅ **Normalized** - No data duplication  
✅ **Efficient** - Update summaries once, not per message  
✅ **Scalable** - Works for 10 or 10,000 messages  
✅ **Standard pattern** - Like Slack, Discord, iMessage  

### Analogy

Think of it like:
- **Chat** = Email Thread (has subject, participant count, summary)
- **PostMessage** = Individual Email (has sender, content, timestamp)

You wouldn't store the thread subject in every email! Same principle here.
