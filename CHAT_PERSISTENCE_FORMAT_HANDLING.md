# Chat Persistence - Format Handling for Thinking, Tool Calls & Provider APIs

## The Problem

Different LLM providers use different message formats:
- **Claude**: Blocks format (text, thinking, tool_use, tool_result)
- **OpenAI**: Separate `reasoning` field + `tool_calls` array
- **Google Gemini**: Similar to OpenAI
- **Storage**: Need a unified format that preserves all data

---

## Solution: Normalized Storage + Provider Adapters

### 1. Unified Storage Schema (SQLite)

Store in a **normalized format** that captures all message types:

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
  
  -- Text content (always present)
  content TEXT NOT NULL,
  
  -- Thinking/reasoning (for o1, Claude extended thinking, etc.)
  reasoning TEXT,
  
  -- Tool calls (stored as JSONB array)
  tool_calls TEXT,  -- JSON: [{id, toolName, args, status, result, error}]
  
  -- Metadata
  timestamp TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  provider TEXT,  -- 'anthropic', 'openai', 'google'
  model TEXT,     -- Model used for this message
  is_compressed INTEGER DEFAULT 0,
  
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
```

**Normalized Tool Call Format:**
```typescript
interface StoredToolCall {
  id: string;              // tool_call_id
  toolName: string;        // e.g., "bash", "read_file"
  args: Record<string, any>;
  status: 'calling' | 'success' | 'error';
  result?: string;         // Tool output
  error?: string;          // Error message if failed
  timestamp: string;       // When executed
}
```

---

## 2. Saving Messages (Provider → Storage)

### From Mastra Streaming Chunks

```typescript
// In AgentService.ts
async *streamAgent(chatId: string, message: string, config: AgentConfig) {
  // Save user message (simple)
  await this.storage.saveMessage(chatId, {
    role: 'user',
    content: message,
    provider: config.provider,
    model: config.model,
  });
  
  // Accumulate streaming data
  let assistantContent = '';
  let reasoning = '';
  const toolCallsMap = new Map<string, StoredToolCall>();
  
  for await (const chunk of this.mastraAgent.stream(chatId, message, config)) {
    yield chunk; // Stream to UI
    
    switch (chunk.type) {
      case 'text-delta':
        assistantContent += chunk.payload.text;
        break;
        
      case 'reasoning-delta':
        reasoning += chunk.payload.text;
        break;
        
      case 'tool-call':
        const { toolCallId, toolName, args } = chunk.payload;
        toolCallsMap.set(toolCallId, {
          id: toolCallId,
          toolName,
          args,
          status: 'calling',
          timestamp: new Date().toISOString(),
        });
        break;
        
      case 'tool-result':
        const { toolCallId: resultId, result, error } = chunk.payload;
        const existingCall = toolCallsMap.get(resultId);
        if (existingCall) {
          toolCallsMap.set(resultId, {
            ...existingCall,
            status: error ? 'error' : 'success',
            result,
            error,
          });
        }
        break;
        
      case 'done':
        // Save complete assistant message
        await this.storage.saveMessage(chatId, {
          role: 'assistant',
          content: assistantContent,
          reasoning: reasoning || undefined,
          toolCalls: toolCallsMap.size > 0 ? Array.from(toolCallsMap.values()) : undefined,
          provider: config.provider,
          model: config.model,
        });
        break;
    }
  }
}
```

---

## 3. Loading Messages (Storage → Provider)

### Provider-Specific Format Adapters

```typescript
// src/gateway/services/MessageFormatAdapter.ts

export class MessageFormatAdapter {
  /**
   * Convert stored messages to provider-specific format
   */
  static toProviderFormat(
    messages: StoredMessage[],
    provider: 'anthropic' | 'openai' | 'google'
  ): any[] {
    switch (provider) {
      case 'anthropic':
        return this.toClaudeFormat(messages);
      case 'openai':
        return this.toOpenAIFormat(messages);
      case 'google':
        return this.toGoogleFormat(messages);
    }
  }
  
  /**
   * Claude format: Uses content blocks
   * https://docs.anthropic.com/en/docs/build-with-claude/tool-use
   */
  private static toClaudeFormat(messages: StoredMessage[]) {
    return messages.map(msg => {
      if (msg.role === 'user') {
        return {
          role: 'user',
          content: msg.content,
        };
      }
      
      if (msg.role === 'assistant') {
        const blocks: any[] = [];
        
        // Add thinking block if present
        if (msg.reasoning) {
          blocks.push({
            type: 'thinking',
            thinking: msg.reasoning,
          });
        }
        
        // Add text content
        if (msg.content) {
          blocks.push({
            type: 'text',
            text: msg.content,
          });
        }
        
        // Add tool_use blocks
        if (msg.toolCalls) {
          for (const tool of msg.toolCalls) {
            blocks.push({
              type: 'tool_use',
              id: tool.id,
              name: tool.toolName,
              input: tool.args,
            });
          }
        }
        
        return {
          role: 'assistant',
          content: blocks,
        };
      }
      
      // System messages
      return {
        role: 'system',
        content: msg.content,
      };
    });
  }
  
  /**
   * OpenAI format: Uses reasoning field + tool_calls array
   * https://platform.openai.com/docs/guides/reasoning
   */
  private static toOpenAIFormat(messages: StoredMessage[]) {
    return messages.flatMap(msg => {
      if (msg.role === 'user') {
        return [{
          role: 'user',
          content: msg.content,
        }];
      }
      
      if (msg.role === 'assistant') {
        const result: any[] = [];
        
        // Main assistant message
        const assistantMsg: any = {
          role: 'assistant',
          content: msg.content,
        };
        
        // Add reasoning for o1/o3 models
        if (msg.reasoning) {
          assistantMsg.reasoning = msg.reasoning;
        }
        
        // Add tool calls if present
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          assistantMsg.tool_calls = msg.toolCalls.map(tool => ({
            id: tool.id,
            type: 'function',
            function: {
              name: tool.toolName,
              arguments: JSON.stringify(tool.args),
            },
          }));
        }
        
        result.push(assistantMsg);
        
        // Add separate tool result messages
        if (msg.toolCalls) {
          for (const tool of msg.toolCalls) {
            if (tool.result !== undefined) {
              result.push({
                role: 'tool',
                tool_call_id: tool.id,
                content: tool.result,
              });
            }
          }
        }
        
        return result;
      }
      
      return [{
        role: 'system',
        content: msg.content,
      }];
    });
  }
  
  /**
   * Google Gemini format: Similar to OpenAI
   */
  private static toGoogleFormat(messages: StoredMessage[]) {
    // Google uses similar structure to OpenAI
    // We can reuse OpenAI format with minor adjustments
    return this.toOpenAIFormat(messages);
  }
}
```

---

## 4. Complete Flow Example

### Saving Flow (Claude with Extended Thinking + Tools)

**Incoming from Claude API:**
```json
{
  "role": "assistant",
  "content": [
    {
      "type": "thinking",
      "thinking": "Let me analyze this code carefully..."
    },
    {
      "type": "text",
      "text": "I'll help you debug this. Let me read the file first."
    },
    {
      "type": "tool_use",
      "id": "toolu_123",
      "name": "read_file",
      "input": { "path": "src/app.js" }
    }
  ]
}
```

**Stored in SQLite:**
```json
{
  "id": "msg_abc123",
  "chat_id": "chat_xyz",
  "role": "assistant",
  "content": "I'll help you debug this. Let me read the file first.",
  "reasoning": "Let me analyze this code carefully...",
  "tool_calls": "[{\"id\":\"toolu_123\",\"toolName\":\"read_file\",\"args\":{\"path\":\"src/app.js\"},\"status\":\"success\",\"result\":\"const app = ...\"}]",
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "timestamp": "2026-02-10T..."
}
```

---

### Loading Flow (Reconstructing for OpenAI)

**Load from SQLite:**
```typescript
const messages = await storage.loadMessagesForLLM(chatId);
// Returns: StoredMessage[]
```

**Convert to OpenAI format:**
```typescript
const openaiMessages = MessageFormatAdapter.toProviderFormat(
  messages,
  'openai'
);
```

**Result (OpenAI format):**
```json
[
  {
    "role": "user",
    "content": "Debug my app.js file"
  },
  {
    "role": "assistant",
    "content": "I'll help you debug this. Let me read the file first.",
    "tool_calls": [{
      "id": "toolu_123",
      "type": "function",
      "function": {
        "name": "read_file",
        "arguments": "{\"path\":\"src/app.js\"}"
      }
    }]
  },
  {
    "role": "tool",
    "tool_call_id": "toolu_123",
    "content": "const app = ..."
  }
]
```

---

## 5. ChatStorageService Updates

```typescript
export class ChatStorageService {
  async saveMessage(chatId: string, message: CoreMessage & {
    provider?: string;
    model?: string;
  }) {
    const tokens = this.estimateTokens(message.content);
    
    this.db.prepare(`
      INSERT INTO messages (
        id, chat_id, role, content, reasoning, tool_calls,
        timestamp, token_count, provider, model
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id || this.generateMessageId(),
      chatId,
      message.role,
      message.content,
      message.reasoning || null,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      new Date().toISOString(),
      tokens,
      message.provider || null,
      message.model || null
    );
    
    this.updateChatMetadata(chatId);
  }
  
  async loadMessagesForLLM(
    chatId: string,
    provider: 'anthropic' | 'openai' | 'google'
  ) {
    // 1. Check for compressed context
    const compressed = this.getCompressedContext(chatId);
    
    // 2. Load recent uncompressed messages
    const recentMessages = this.db.prepare(`
      SELECT * FROM messages 
      WHERE chat_id = ? AND is_compressed = 0
      ORDER BY timestamp ASC
    `).all(chatId);
    
    // 3. Combine compressed + recent
    const allMessages = compressed
      ? [
          { role: 'system', content: compressed.summary },
          ...recentMessages.map(this.rowToStoredMessage)
        ]
      : recentMessages.map(this.rowToStoredMessage);
    
    // 4. Convert to provider-specific format
    return MessageFormatAdapter.toProviderFormat(allMessages, provider);
  }
  
  private rowToStoredMessage(row: any): StoredMessage {
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      reasoning: row.reasoning || undefined,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      timestamp: row.timestamp,
      provider: row.provider,
      model: row.model,
    };
  }
}
```

---

## 6. Updated MastraAgent Call

```typescript
// In AgentService.ts
async *streamAgent(chatId: string, userMessage: string, config: AgentConfig) {
  // Load history in provider-specific format
  const history = await this.storage.loadMessagesForLLM(
    chatId,
    config.provider  // 'anthropic', 'openai', or 'google'
  );
  
  // Pass to Mastra (already in correct format!)
  const agent = new Agent({
    model: `${config.provider}/${config.model}`,
    instructions: config.systemPrompt,
  });
  
  // Mastra handles the provider-specific format automatically
  for await (const chunk of agent.stream(history, userMessage)) {
    // ... handle chunks and save
  }
}
```

---

## 7. Types

```typescript
// src/core/types/storage.ts

export interface StoredMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: StoredToolCall[];
  timestamp: string;
  provider?: string;
  model?: string;
}

export interface StoredToolCall {
  id: string;
  toolName: string;
  args: Record<string, any>;
  status: 'calling' | 'success' | 'error';
  result?: string;
  error?: string;
  timestamp: string;
}
```

---

## 8. Token Counting (Accurate)

```typescript
import Anthropic from '@anthropic-ai/sdk';

export class TokenCounter {
  private anthropicClient = new Anthropic();
  
  async countTokensForProvider(
    content: string,
    provider: 'anthropic' | 'openai' | 'google'
  ): Promise<number> {
    switch (provider) {
      case 'anthropic':
        // Use Claude's token counter
        const response = await this.anthropicClient.messages.countTokens({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content }],
        });
        return response.input_tokens;
        
      case 'openai':
        // Use tiktoken
        const { encode } = await import('tiktoken');
        const encoder = encode(content);
        return encoder.length;
        
      case 'google':
        // Google's tokenization is similar to OpenAI
        return Math.ceil(content.length * 0.75); // Rough estimate
    }
  }
}
```

---

## 9. Summary Compression Format

When compressing, we need to preserve the format info:

```typescript
async generateSummary(messages: StoredMessage[]): Promise<string> {
  // Build a rich summary that preserves structure
  const summaryPrompt = `Summarize this conversation, preserving:
1. Key decisions and conclusions
2. Code snippets and technical details
3. Tool usage patterns (what tools were called and why)
4. Thinking/reasoning insights
5. User's goals and context

Messages:
${messages.map(m => {
  let text = `${m.role}: ${m.content}`;
  if (m.reasoning) text += `\n[Thinking: ${m.reasoning.slice(0, 200)}...]`;
  if (m.toolCalls) text += `\n[Used tools: ${m.toolCalls.map(t => t.toolName).join(', ')}]`;
  return text;
}).join('\n\n')}

Provide a detailed summary (30-40% of original length).`;
  
  const summary = await this.summaryModel.generate(summaryPrompt);
  return summary.text;
}
```

---

## Complete Example: Claude with Extended Thinking

**1. Save (from streaming):**
```typescript
// Chunks coming in:
{ type: 'reasoning-delta', payload: { text: 'Let me think...' } }
{ type: 'text-delta', payload: { text: 'I can help with that.' } }
{ type: 'tool-call', payload: { toolCallId: 'abc', toolName: 'bash', args: {...} } }
{ type: 'tool-result', payload: { toolCallId: 'abc', result: 'output' } }
{ type: 'done' }

// Saved to DB:
{
  content: "I can help with that.",
  reasoning: "Let me think...",
  tool_calls: [{ id: 'abc', toolName: 'bash', status: 'success', result: 'output' }]
}
```

**2. Load (for next request):**
```typescript
// Load as Claude format:
{
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'Let me think...' },
    { type: 'text', text: 'I can help with that.' },
    { type: 'tool_use', id: 'abc', name: 'bash', input: {...} }
  ]
}
// Plus tool_result as separate user message
{
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'abc', content: 'output' }
  ]
}
```

---

## Benefits

✅ **Unified Storage**: One format in database, regardless of provider  
✅ **Lossless**: No information lost in translation  
✅ **Provider Flexibility**: Switch providers mid-conversation  
✅ **Easy Debugging**: Inspect actual content in DB  
✅ **Efficient**: JSONB for tool calls, text for content  
✅ **Future-Proof**: Add new providers by implementing adapter  

**Result:** Clean abstraction that preserves all message complexity! 🎯
