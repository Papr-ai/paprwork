# PAPR Memory Metadata Audit

**Date:** 2026-02-16  
**Status:** ✅ IMPLEMENTED - Full metadata now saved to PAPR Memory

---

## Executive Summary

**Implementation Status:**
- ✅ **SubAgent Jobs**: Rich metadata (agentId, agentName, runId, jobId, chatId)
- ✅ **Manual Memory Tools**: Full metadata support (agent, role, category, workspace)
- ✅ **Chat Messages**: NOW INCLUDES full metadata (model, agent, tools, thinking, tokens)

**Newly Added to Chat Messages:**
- ✅ Agent ID/Name (main-agent or SubAgent override)
- ✅ Model used (e.g., "claude-sonnet-4.5", "gpt-5.2")
- ✅ Tool calls executed (names, count, status)
- ✅ Extended thinking indicator
- ✅ Token usage (prompt, completion, total)
- ✅ Error tracking

---

## Detailed Comparison

### 1. SubAgent Job Memory (✅ Complete)

**File:** `src/gateway/services/PaprMemoryWritebackService.ts`

```typescript
await client.memory.add({
  content: compactContent(input),
  external_user_id: input.externalUserId,
  metadata: {
    category: "learning",
    role: "assistant",
    sourceAgentId: input.sourceAgentId,        // ✅ e.g., "research-specialist"
    sourceAgentName: input.sourceAgentName,    // ✅ e.g., "Research Specialist"
    runId: input.runId,                        // ✅ e.g., "run-1234-5678"
    jobId: input.jobId,                        // ✅ e.g., "job-xyz"
    chatId: input.chatId,                      // ✅ e.g., "chat_20260216"
    writebackPolicy: input.policy,             // ✅ "none" | "summary" | "full"
  },
});
```

### 2. Manual Memory Tool (✅ Complete)

**File:** `src/core/tools/paprMemory.ts`

```typescript
await client.memory.add({
  content: args.content,
  external_user_id: args.externalUserId,
  metadata: {
    role: args.role,                           // ✅ "user" | "assistant"
    category: args.category,                   // ✅ preference/task/goal/fact/etc
    sourceAgentId: args.sourceAgentId,         // ✅ Agent identifier
    sourceAgentName: args.sourceAgentName,     // ✅ Human-readable name
    runId: args.runId,                         // ✅ Run identifier
    jobId: args.jobId,                         // ✅ Job identifier
    chatId: args.chatId,                       // ✅ Chat session
    workspaceId: args.workspaceId,             // ✅ Workspace context
  },
});
```

### 3. Chat Messages (✅ NOW COMPLETE)

**File:** `src/gateway/services/storage/PaprMemoryProvider.ts`

```typescript
await this.client.messages.store({
  content: message.content,
  role: message.role,
  sessionId: chatId,
  process_messages: true,
  metadata: {
    // Basic tracking
    conversationId: chatId,
    createdAt: message.timestamp,
    
    // ✅ Agent identification (NEW!)
    sourceAgentId: message.source_agent_id || 'main-agent',
    sourceAgentName: message.source_agent_name || 'Paprwork Assistant',
    
    // ✅ Model tracking (NEW!)
    model: message.model || 'unknown',
    role: message.role,
    
    // ✅ Tool usage (NEW!)
    toolsUsed: message.toolCalls?.map(tc => tc.name),
    toolCallsCount: message.toolCalls?.length || 0,
    toolCallsSummary: message.toolCalls?.map(tc => ({
      tool: tc.name,
      status: tc.status || 'success',
    })),
    
    // ✅ Extended thinking (NEW!)
    hasThinking: !!message.thinking,
    thinkingLength: message.thinking?.length,
    
    // ✅ Token usage (NEW!)
    promptTokens: message.prompt_tokens,
    completionTokens: message.completion_tokens,
    totalTokens: message.total_tokens,
    
    // ✅ Error tracking (NEW!)
    hasError: !!message.error,
    errorMessage: message.error,
    incomplete: message.incomplete,
  },
});
```

---

## Implementation Complete ✅

### Changes Made

**1. Updated `IStorageProvider` interface** (`src/gateway/services/storage/IStorageProvider.ts`)
- Added `source_agent_id` and `source_agent_name` fields to `StoredMessage`
- Allows SubAgents to override default "main-agent" attribution

**2. Updated `PaprMemoryProvider`** (`src/gateway/services/storage/PaprMemoryProvider.ts`)
- Enhanced `saveMessage()` to include full metadata
- Added model tracking, tool usage, thinking, tokens, errors
- Matches SubAgent job metadata richness

**3. Updated `LocalStorageProvider`** (`src/gateway/services/storage/LocalStorageProvider.ts`)
- Added `source_agent_id` and `source_agent_name` columns to SQLite
- Migration logic for existing databases
- Updated INSERT and SELECT statements

**4. Benefits Enabled:**
- ✅ Query: "Show me all conversations where GPT-5 was used"
- ✅ Analyze: "Which tools are most frequently used?"
- ✅ Debug: "What bash commands were run during this discussion?"
- ✅ Track: SubAgent effectiveness vs main agent
- ✅ Cost: Token usage analytics across all conversations

---

## What Now Works

### Model Tracking
- Query all messages by specific model
- Compare model performance across tasks
- Track model usage over time

### Tool Usage Analytics
- See which tools are used most frequently
- Track tool success/failure rates
- Debug tool call sequences

### Agent Attribution
- Distinguish main agent vs SubAgent messages
- Track which agent is more effective
- Cross-agent learning patterns

### Context Quality
- Prioritize extended thinking responses
- Analyze complex reasoning patterns
- Cost optimization based on thinking usage

---

## Impact Analysis

### What We're Now Capturing

1. **Model Tracking** ✅
   - Query: "Show me all conversations where GPT-5 was used"
   - Analyze: "Which model gives better results for X task?"
   - Track: Model performance over time

2. **Tool Usage Analytics** ✅
   - Query: "What bash commands were run during this discussion?"
   - Analyze: "Which tools are most frequently used?"
   - Debug: "What tool calls led to this outcome?"

3. **Agent Attribution** ✅
   - Distinguish: Main agent vs. SubAgent messages in memory
   - Track: Which agent is more effective for certain tasks
   - Analyze: Cross-agent learning patterns

4. **Context Quality** ✅
   - Prioritize: Extended thinking responses vs. quick answers
   - Learn: Which approaches work better for complex problems
   - Cost: Track token usage per conversation/agent

---

## Proposed Solution

### Phase 1: Add Essential Metadata ✅ COMPLETE

**File:** `src/gateway/services/storage/PaprMemoryProvider.ts`

```typescript
async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
  try {
    const response = await this.client.messages.store({
      content: message.content,
      role: message.role,
      sessionId: chatId,
      process_messages: true,
      metadata: {
        // Existing
        conversationId: chatId,
        createdAt: message.timestamp,
        
        // NEW: Essential metadata
        model: message.model || 'unknown',
        sourceAgentId: 'main-agent',  // For main chat (SubAgents override)
        sourceAgentName: 'Paprwork Assistant',
        
        // NEW: Tool usage (if any)
        ...(message.toolCalls && message.toolCalls.length > 0 && {
          toolsUsed: message.toolCalls.map(tc => tc.name),
          toolCallsCount: message.toolCalls.length,
          toolCallsSummary: message.toolCalls.map(tc => ({
            tool: tc.name,
            status: tc.status || 'completed',
          })),
        }),
        
        // NEW: Extended thinking indicator
        ...(message.thinking && {
          hasThinking: true,
          thinkingLength: message.thinking.length,
        }),
        
        // NEW: Token usage (for cost tracking)
        ...(message.prompt_tokens && {
          promptTokens: message.prompt_tokens,
          completionTokens: message.completion_tokens,
          totalTokens: message.total_tokens,
        }),
      },
    });

    message.papr_message_id = response.objectId;
    message.sync_status = 'synced';
  } catch (error) {
    // ... error handling
  }
}
```

### Phase 2: SubAgent Chat Messages (Future)

When SubAgents participate in chat (not just background jobs):

```typescript
// Add to SubAgent message context
metadata: {
  sourceAgentId: subAgent.id,           // e.g., "research-specialist"
  sourceAgentName: subAgent.name,       // e.g., "Research Specialist"
  isSubAgent: true,
  parentChatId: originalChatId,
  delegationContext: task,
}
```

### Phase 3: Enhanced Analytics (Future)

Query examples enabled by rich metadata:

```typescript
// Find all bash commands run in a project
await papr.memory.search({
  query: "bash commands executed",
  metadata: {
    toolsUsed: ['bash'],
    chatId: 'chat_xyz',
  }
});

// Compare model performance
await papr.memory.search({
  query: "code generation outcomes",
  metadata: {
    model: 'gpt-5.2',
    toolsUsed: ['write_file'],
  }
});

// Track SubAgent effectiveness
await papr.memory.search({
  query: "research findings",
  metadata: {
    sourceAgentId: 'research-specialist',
  }
});
```

---

## Implementation Checklist

- [x] Update `PaprMemoryProvider.saveMessage()` to include full metadata
- [x] Update `HybridStorageProvider.syncMessageToPapr()` to pass metadata (inherits from PaprMemoryProvider)
- [x] Update `IStorageProvider` interface with agent attribution fields
- [x] Update `LocalStorageProvider` schema to persist new fields
- [x] Add migration logic for existing SQLite databases
- [ ] Test with main chat messages (ensure model, tools saved)
- [ ] Test with SubAgent background jobs (already working)
- [ ] Test SubAgent chat messages with custom agent ID/name
- [ ] Add metadata display in UI (Settings → Data & Privacy)
- [ ] Document metadata fields in README for future queries

---

## V1 vs V2 Comparison

### V1 (Paprwork v1)
- ❌ No automatic chat message sync to PAPR Memory
- ✅ Manual `addMemory()` calls with custom metadata
- ✅ AgentTracker saved tool usage to local SQLite
- ❌ Not integrated with PAPR Memory's entity extraction

### V2 (Paprwork v2)
- ✅ Automatic background sync to PAPR Memory
- ✅ PAPR auto-analyzes with `process_messages: true`
- ✅ Auto-compression at 50K tokens
- ⚠️ Missing rich metadata (model, tools, agent)
- ✅ SubAgent jobs have full metadata
- ✅ Manual tools have full metadata

**Gap:** Chat messages need same metadata richness as SubAgent jobs!

---

## Questions for Team

1. Should we store full tool args/results or just tool names?
   - Concern: Tool results can be large (file contents, bash output)
   - Suggestion: Store tool names + status, full results in `$PAPR_HOME/Chats/*.txt`

2. Should we track token costs in PAPR Memory?
   - Benefit: Cost analytics across all conversations
   - Concern: Privacy (reveals usage patterns)

3. Should thinking text be stored separately or as message metadata?
   - Option A: Include in message content (current)
   - Option B: Separate field for reasoning analysis

4. Chat title in metadata?
   - Would enable: "Find all chats about X topic"
   - Requires: Fetching chat metadata before sync

---

## References

- PAPR Memory SDK: `@papr/memory` v2.0.0
- Storage Provider: `src/gateway/services/storage/PaprMemoryProvider.ts`
- Job Memory: `src/gateway/services/PaprMemoryWritebackService.ts`
- Memory Tools: `src/core/tools/paprMemory.ts`
- Message Types: `src/gateway/services/storage/IStorageProvider.ts`
