# Actionable Tool Result Truncation

**Added:** 2026-04-10
**Status:** ✅ IMPLEMENTED

## Problem

Tool results can be large (up to 100KB each). When loading into LLM context, they're truncated to prevent context overflow, but the agent had no way to access the full result if they needed more details. Truncation messages were passive:

```
[... 47523 chars truncated from history]
[... 5000 chars truncated (tool #3 from end, limit: ~500 tokens)]
```

This left agents stuck when they needed deeper information from truncated results.

## Solution

Made truncation messages **actionable** by:
1. Adding `get_full_tool_result` tool to retrieve full results from chat history
2. Enhancing truncation messages to include **both** tool usage AND direct data access
3. Supporting partial reads (pagination) for extremely large results

**Hybrid approach:** Agent can use simple tool OR query database directly for advanced needs.

## Implementation

### New Tool: `get_full_tool_result`

```typescript
get_full_tool_result({
  toolCallId: "toolu_abc123",           // From truncation notice
  toolName: "list_schemas",             // Optional, helps narrow search
  searchIn: "current_chat",             // or "all_chats"
  startChar: 0,                         // Optional: for pagination
  length: 50000                         // Optional: read 50KB at a time
})
```

**How it works:**
- Searches chat history (last 5 chats by default, or specific chatId)
- Finds tool call by `toolCallId` (unique ID generated for each tool execution)
- Returns full result or a paginated section
- Provides `nextStartChar` for continuing pagination

### Enhanced Truncation Messages

**History truncation** (400 chars max):
```
[... 5000 chars truncated. 
Tool: get_full_tool_result({ toolCallId: "toolu_abc", toolName: "list_schemas" }) 
OR query: ~/.paprwork-v2/chats.db → messages.parts (JSONL)]
```

**Recency-based truncation** (2KB-8KB depending on position):
```
[... 15000 chars truncated (tool #3 from end, limit: ~2000 tokens, context: 45K/low). 
Tool: get_full_tool_result({ toolCallId: "toolu_xyz" }) 
OR query: ~/.paprwork-v2/chats.db → messages.parts]
```

**Emergency truncation** (>200KB results):
```
[⚠️ EMERGENCY TRUNCATION: Result was 520KB (130K tokens), truncated 320KB. 
Tool: get_full_tool_result({ toolCallId: "toolu_def", startChar: 200000, length: 50000 }) 
OR query: ~/.paprwork-v2/chats.db → messages.parts]
```

## Papr Memory Schema Tools

Also added missing `get_schema` tool for Papr Memory:

**Before:**
- `list_schemas` - Returned FULL schema objects (10K+ chars when many schemas exist)
- No way to get details for ONE schema

**After:**
- `list_schemas` - Returns lightweight summary (id, name, description, nodeTypeCount, relationshipCount)
- `get_schema(schemaId)` - Returns full schema details for ONE schema (~2-5KB, fits in context)

**Example workflow:**
```typescript
// 1. Get overview of all schemas (fast, ~500 chars)
list_schemas() 
// Returns: { schemas: [{ id: "BNSv8YCQXJ", name: "SalesIntelligence", nodeTypeCount: 10 }] }

// 2. Get full details for one schema
get_schema({ schemaId: "BNSv8YCQXJ" })
// Returns: Full node types, relationships, properties
```

## Use Cases

### 1. Simple Case: Use the Tool (90%)
```
Agent: list_schemas()
Result: [200 schemas shown, ... 50000 chars truncated. Tool: get_full_tool_result(...)]
Agent: get_full_tool_result({ toolCallId: "toolu_123", startChar: 0, length: 10000 })
Result: [Next 10KB of schemas]
```

### 2. Advanced Case: Query Database Directly (10%)
```
Agent: bash({ command: "find ~/Papr -name '*.py' -exec cat {} \\;" })
Result: [First 200KB shown, ... 800KB truncated. OR query: ~/.paprwork-v2/chats.db]
Agent: bash({ command: `sqlite3 ~/.paprwork-v2/chats.db "
  SELECT json_extract(parts, '$[*].result') 
  FROM messages 
  WHERE json_extract(parts, '$[*].toolName') = 'bash'
    AND json_extract(parts, '$[*].toolCallId') = 'toolu_456'
" | jq -r '.[0]' | grep -A 10 'class MyClass'` })
Result: [Specific section of Python code with grep filter]
```

### 3. Time-Based Query (Advanced)
```
# Agent needs results from 3 days ago (not in recent 5 chats)
Agent: bash({ command: `sqlite3 ~/.paprwork-v2/chats.db "
  SELECT m.parts 
  FROM messages m 
  JOIN chats c ON m.chat_id = c.id 
  WHERE c.created_at > date('now', '-3 days')
    AND json_extract(parts, '\$[*].toolCallId') LIKE '%toolu_xyz%'
"` })
# ✅ Fast: SQL filter, only recent chats
```

## Architecture

### Storage Location
Full tool results are stored in SQLite (`~/.paprwork-v2/chats.db`):
- Table: `messages`
- Column: `parts` (JSONL containing sequence of text, tool-call, tool-result parts)
- Each tool result saved with metadata: `{ id, name, args, result, status }`

### Search Strategy
1. **Current chat** (default): Searches last 5 chats by `updated_at` DESC
2. **Specific chat**: `chatId` parameter overrides search
3. **All chats**: `searchIn: "all_chats"` searches entire history
4. **Most recent first**: Searches messages in reverse (newest → oldest)

### Performance
- Index on `chat_id` and `updated_at` for fast lookups
- 10MB cache + 30MB mmap for fast reads (Windows optimized)
- Average query time: 10-50ms for 50 messages

## Files Changed

**Core Tools:**
- `src/core/tools/chatHistory.ts` - NEW: `get_full_tool_result` tool
- `src/core/tools/paprMemory.ts` - Added `get_schema` tool, lightweight `list_schemas` response
- `src/core/tools/index.ts` - Exported new tools

**Truncation Messages:**
- `src/gateway/services/agent/historyFormatter.ts` - Added actionable message to history truncation
- `src/gateway/services/AgentService.ts` - Added actionable messages to recency-based + emergency truncation

## Testing

### Manual Test: Get Full Tool Result
```typescript
// 1. Run a tool with large output
bash({ command: "ls -lR ~/Papr" })
// Result gets truncated with toolCallId

// 2. Get full result
get_full_tool_result({ toolCallId: "toolu_...", searchIn: "current_chat" })
// Returns: Full output

// 3. Paginate through large result
get_full_tool_result({ toolCallId: "toolu_...", startChar: 0, length: 50000 })
get_full_tool_result({ toolCallId: "toolu_...", startChar: 50000, length: 50000 })
```

### Manual Test: Schema Discovery
```typescript
// 1. List schemas (lightweight)
list_schemas()
// Returns: Summary with nodeTypeCount

// 2. Get full schema details
get_schema({ schemaId: "BNSv8YCQXJ" })
// Returns: Full node types, relationships
```

## Impact

| Metric | Before | After |
|--------|--------|-------|
| Agent stuck on truncation | ❌ Yes (no recourse) | ✅ No (2 options: tool OR bash) |
| Truncation message | Passive info | Actionable (tool + data location) |
| Schema discovery | One call, 10K+ chars | Two calls, 500 chars + 3KB |
| Large results | All or nothing | Paginated access (tool) OR custom query (bash) |
| Context efficiency | Wasted on unneeded data | Load on-demand |
| Flexibility | Tool-only | Hybrid (simple tool + advanced bash) |

## Why Hybrid Approach?

**Best of both worlds:**
1. **90% case:** Agent uses simple tool (fast, type-safe, portable)
2. **10% case:** Agent needs custom query (has path to data, full SQL/jq power)
3. **Discovery:** Agent learns data architecture (SQLite, JSONL structure)
4. **Fallback:** If tool fails, agent can bash their way out
5. **Teaching:** Transparency about where data lives builds agent knowledge

## Future Enhancements

1. **Smart caching**: Keep most recent `get_full_tool_result` in memory
2. **SQLite helper**: `query_chat_db({ sql: "SELECT ...", format: "json" })` tool
3. **Format conversion**: Return as JSON/CSV/markdown instead of raw
4. **Result expiration**: Auto-delete old tool results after 7 days
5. **Compression**: Store large results compressed, decompress on read
6. **Example queries**: Add common SQL patterns to SystemPrompt

## Related

- Enhancement 8: Tool Result Truncation Fix (original 2KB truncation)
- Issue 10: OAuth Context Management (context pressure monitoring)
- Issue 17: GPT-5.4 Context Limit (model-aware thresholds)
- Enhancement 42: Proactive Integration (bash + packages = access to anything)

---

**Key Insight:** Don't just truncate - give the agent TWO paths: (1) Simple tool for common case, (2) Direct data access for power users. Transparency + flexibility = autonomous problem-solving.
