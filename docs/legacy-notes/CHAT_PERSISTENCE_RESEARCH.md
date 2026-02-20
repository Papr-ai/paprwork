# Chat Persistence Research - Best Practices for Paprwork v2

## Executive Summary

Based on research of OpenClaw, Claude's compaction system, and industry best practices, here's our recommended approach for Paprwork v2 chat persistence.

---

## 1. Paprwork v1 Issues (What to Avoid)

### Critical Problems
- ❌ **Dual save paths** (main + renderer) causing duplication
- ❌ **Complex format translation** (structured ↔ API formats)
- ❌ **Orphaned files** (`_llm.jsonl` not cleaned up)
- ❌ **Index file rewrites** on every message (I/O overhead)
- ❌ **Full-file reads** for every load (no pagination)
- ❌ **Bug-prone tool cleanup** (70-line `removeIncompleteToolCalls`)
- ❌ **Multiple save triggers** (streaming-complete, tool-loop, manual, auto)

### Storage Layout (v1)
```
~/Library/Application Support/consumer-app-builder/chats/
├── index.json              # Metadata for all chats
├── {chatId}.jsonl          # Full history (never compressed)
└── {chatId}_llm.jsonl      # Compressed history for LLM
```

---

## 2. Industry Best Practices

### A. Storage Format

**Winner: SQLite with JSONB** ✅

**Why:**
- JSONB is 5-10% smaller than text JSON
- Processes in <50% CPU cycles vs text JSON
- Structured queries for filtering/search
- Strong consistency guarantees
- Single file, no orphaned files
- Built-in indexing and transactions

**Alternative:** IndexedDB for browser-based (if we go full web)

### B. Compression Strategy (3-Layer Approach from Claude Code)

**Layer 1: Microcompaction** (Immediate)
- Offload bulky tool outputs to disk early
- Keep only recent results visible
- **Trigger**: Tool result > 10KB

**Layer 2: Auto-Compaction** (Smart Threshold)
- Monitor context usage percentage
- Trigger at 60-70% usage (not waiting until full)
- Preserve: system messages, recent messages (last 10-20), critical function pairs
- **Trigger**: Context > 60%, or token count > 100K

**Layer 3: Manual Compaction** (User Control)
- User-triggered at task boundaries
- Optional focus hints for what to preserve
- Full history always accessible in UI
- **Trigger**: User action or chat switch

### C. Context Window Management

**Key Principles:**
1. ✅ **Preserve system messages** - Never compress the system prompt
2. ✅ **Keep function pairs together** - Tool call + result as atomic unit
3. ✅ **Maintain recent context** - Last 10-20 messages always full
4. ✅ **Semantic summarization** - Use LLM to summarize old context
5. ✅ **Headroom accounting** - Reserve space for output + compaction ops

**Acon Framework Insights** (26-54% memory reduction):
- Analyze failed compression attempts
- Update compression guidelines dynamically
- Can distill into smaller models (95%+ accuracy)

---

## 3. Recommended Architecture for Paprwork v2

### Storage Schema (SQLite)

```sql
-- Chats table
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_count INTEGER DEFAULT 0,
  summary TEXT,
  context_usage_pct REAL DEFAULT 0,
  last_compaction_at TEXT,
  UNIQUE(id)
);

-- Messages table (full history - never deleted)
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,  -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,  -- Plain text for user, JSONB for assistant
  reasoning TEXT,  -- Thinking content
  tool_calls TEXT,  -- JSONB array of tool calls
  timestamp TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  is_compressed BOOLEAN DEFAULT 0,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX idx_messages_chat_id ON messages(chat_id);
CREATE INDEX idx_messages_timestamp ON messages(chat_id, timestamp);

-- Compressed context (for LLM)
CREATE TABLE compressed_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  summary TEXT NOT NULL,  -- LLM-generated summary
  message_range TEXT NOT NULL,  -- "msg_1 to msg_50"
  compressed_at TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX idx_compressed_chat_id ON compressed_context(chat_id);
```

### Persistence Flow

**Single Write Path:**
```
User/Assistant Message
  ↓
  Gateway AgentService.stream()
  ↓
  Save to SQLite (messages table)
  ↓
  Update chat metadata (message_count, updated_at)
  ↓
  Check context threshold
  ↓
  If > 60%: Schedule background compaction
```

**Load Flow:**
```
Load Chat for UI
  ↓
  SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp
  ↓
  Display in UI (with pagination)

Load Chat for LLM
  ↓
  Check if compressed_context exists
  ↓
  If yes: Summary + Recent messages (last 20)
  ↓
  If no: All messages (with token limit check)
```

### Compaction Service (Background)

```typescript
class CompactionService {
  // Trigger: context_usage_pct > 60%
  async compactChat(chatId: string) {
    // 1. Get all messages except last 20
    const oldMessages = await getMessagesForCompaction(chatId);
    
    // 2. Generate summary using fast model (gpt-5.2-low or claude-haiku-4-5)
    const summary = await summarize(oldMessages);
    
    // 3. Save compressed context
    await saveCompressedContext(chatId, summary, messageRange);
    
    // 4. Mark old messages as compressed (keep in DB for UI)
    await markMessagesCompressed(oldMessages.map(m => m.id));
    
    // 5. Update chat metadata
    await updateChatMetadata(chatId, {
      last_compaction_at: new Date(),
      context_usage_pct: calculateNewUsage()
    });
  }
}
```

---

## 4. OpenClaw Lessons

**Visibility is Key:**
- Show context usage percentage in UI (like OpenClaw's proposed `context=X%`)
- Allow users to trigger compaction manually
- Provide warnings before auto-compaction

**Session Management:**
- Reload history after gateway/session restart
- Persist cursor positions to prevent message replay
- Don't lose state during unexpected compaction

**Issues to Avoid:**
- Context/state lost after unexpected compaction
- Messages lost after gateway restart
- No visibility into context window usage

---

## 5. Implementation Plan for V2

### Phase 1: Basic Persistence (Week 1)
- ✅ SQLite setup with schema
- ✅ Single write path (Gateway → SQLite)
- ✅ Load chat for UI (paginated)
- ✅ Save messages on stream completion
- ✅ IPC handlers (Electron ↔ Gateway)

### Phase 2: Context Management (Week 2)
- ✅ Token counting per message
- ✅ Context usage tracking
- ✅ Load chat for LLM (with limit check)
- ✅ UI indicator for context usage

### Phase 3: Auto-Compaction (Week 3)
- ✅ Background compaction service
- ✅ Summary generation (using fast model)
- ✅ Compressed context storage
- ✅ Trigger at 60% threshold

### Phase 4: Polish (Week 4)
- ✅ Manual compaction UI
- ✅ Full history export
- ✅ Search/filter messages
- ✅ Chat deletion/cleanup

---

## 6. Key Differences from V1

| Feature | V1 (Complex) | V2 (Simple) |
|---------|-------------|-------------|
| Storage | JSONL (2 files) | SQLite (1 file) |
| Write paths | 2 (main + renderer) | 1 (gateway) |
| Format | Structured → API translation | Direct storage |
| Compression | Manual + auto + callback | Single background service |
| Tool cleanup | 70-line validation | Schema-enforced integrity |
| Orphaned files | Yes (`_llm.jsonl`) | No (SQLite CASCADE) |
| Index rewrites | Every message | Batched transactions |
| Full reads | Always | Paginated queries |
| Context visibility | None | % indicator + warnings |

---

## 7. Storage Size Estimates

**Assumptions:**
- Average message: 500 tokens ≈ 375 words ≈ 2KB text
- Chat with 100 messages: ~200KB
- Compression ratio: 70% (like v1)

**Storage:**
- 1000 chats with 100 messages each: ~200MB
- Compressed contexts: ~60MB (if all compressed)
- **Total: ~260MB** (very manageable)

**SQLite Benefits:**
- Automatic page-level compression
- Efficient indexing
- Transactional integrity
- Single file, no fragmentation

---

## 8. Token Counting Strategy

Use `@anthropic-ai/tokenizer` or `tiktoken` for accurate counting:

```typescript
import { countTokens } from '@anthropic-ai/tokenizer';

async function saveMessageWithTokens(message: CoreMessage) {
  const tokens = await countTokens(message.content);
  
  await db.run(
    'INSERT INTO messages (id, chat_id, content, token_count, ...) VALUES (?, ?, ?, ?, ...)',
    [message.id, chatId, message.content, tokens, ...]
  );
  
  // Update chat context usage
  await updateContextUsage(chatId);
}
```

---

## 9. Compression Prompt Template

```typescript
const COMPRESSION_PROMPT = `You are a conversation summarizer. Compress the following conversation history while preserving:
1. Key decisions and conclusions
2. Important code snippets or technical details
3. User's goals and preferences
4. Critical context for future messages

Conversation to compress:
{messages}

Provide a concise summary (aim for 30% of original length) that captures the essence while maintaining continuity.`;
```

---

## 10. Migration from V1 (Optional)

If users want to migrate from V1:

```typescript
async function migrateV1Chat(chatId: string) {
  // 1. Read v1 JSONL file
  const v1Messages = await readV1JSONL(chatId);
  
  // 2. Transform to v2 schema
  const v2Messages = v1Messages.map(transformMessage);
  
  // 3. Insert into SQLite
  await insertMessages(v2Messages);
  
  // 4. Generate initial summary if needed
  if (v2Messages.length > 50) {
    await compactChat(chatId);
  }
}
```

---

## Summary: The Paprwork v2 Way

**Simple, Single-Path Architecture:**
1. ✅ One storage format (SQLite)
2. ✅ One write path (Gateway)
3. ✅ One compaction service (Background)
4. ✅ One truth source (Database)

**Smart Context Management:**
1. ✅ Track usage percentage
2. ✅ Auto-compact at 60% threshold
3. ✅ Preserve system + recent + critical messages
4. ✅ User visibility and control

**Performance & Reliability:**
1. ✅ Paginated queries (no full reads)
2. ✅ JSONB for efficiency
3. ✅ Transactions for consistency
4. ✅ Cascade deletes (no orphans)
5. ✅ Single file (no fragmentation)

**Result:** Clean, maintainable, performant chat persistence that scales! 🚀
