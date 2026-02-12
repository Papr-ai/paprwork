# Context Management Best Practices

**Date:** 2026-02-12  
**Research Summary:** OpenAI, Anthropic, Academic Research (2025-2026)

## TL;DR - Best Practices

✅ **DO Include:**
- Tool calls (function names, arguments)
- Tool results (outputs from tool execution)
- Thinking/reasoning (for reasoning models like GPT-5.x)
- Complete conversation history

✅ **DO Compress After:** ~20 messages or 50K tokens

❌ **DON'T Exclude:** Tool context breaks multi-turn coherence

---

## Official Guidance

### OpenAI (2026)
> "Include the complete conversation history in subsequent API calls, including:
> - User messages
> - Assistant responses with function calls
> - Tool call results"

**Source:** https://platform.openai.com/docs/guides/function-calling

### Anthropic (Claude)
> "Context window holds your entire conversation including messages, files read, and command outputs. This is the most critical resource to manage."

**Key Strategy:** Track context usage continuously, compress when needed

---

## Research Findings

### 1. Full Context = Better Quality

**Study:** Chain-of-Thought Prompting (ArXiv 2022-2025)
- Including reasoning traces **significantly improves** performance on complex tasks
- Models fine-tuned on full reasoning traces show **strongest performance**

### 2. Selective Compression Works

**Study:** Acon Framework (ArXiv 2025)
- **26-54% token reduction** with minimal performance loss
- **95%+ accuracy retained** with distilled compression
- Approach: Keep critical "thought anchors", compress verbose outputs

**Study:** SWE-Pruner (ArXiv 2026)
- **23-54% token reduction** for coding agents
- Task-aware adaptive pruning (keep relevant lines only)

### 3. Structured Summaries > Raw Summaries

**Study:** Factory.ai Probe Evaluation (2025)
- Structured summaries retain **more functional quality** than raw LLM summaries
- Evaluated on: recall, artifact tracking, continuation, decision-making
- Best format: Bulleted facts + key actions + relevant details

---

## Implementation Strategy

### Phase 1: Full Context (Launch with This)

**When:** Conversations < 20 messages or < 50K tokens

```typescript
// Send EVERYTHING to LLM
messages: [
  {
    role: 'user',
    content: 'What files are in this directory?'
  },
  {
    role: 'assistant',
    content: '',  // May be empty if only tool use
    thinking: 'I need to list files using bash...',
    tool_calls: [{
      id: 'call_abc',
      name: 'bash',
      arguments: { command: 'ls -la', cwd: '', timeout: 60000, env: {} }
    }]
  },
  {
    role: 'tool',
    tool_call_id: 'call_abc',
    name: 'bash',
    content: JSON.stringify({
      stdout: '...[file list]...',
      stderr: '',
      exitCode: 0
    })
  },
  {
    role: 'assistant',
    content: 'There are 5 files in the directory...'
  }
]
```

**Benefits:**
- Simplest to implement
- Best quality for short conversations
- Model sees full context

**Cost:** Higher token usage (acceptable for < 50K tokens)

---

### Phase 2: Smart Compression (Add After Launch)

**When:** Conversations > 20 messages or > 50K tokens

#### Strategy A: Sliding Window + Summary

Keep recent full, summarize old:

```typescript
// For messages 1-10 (old)
{
  role: 'system',
  content: `## Previous Context Summary

**Actions Taken:**
- Listed files in /home/user (5 files found)
- Read package.json (Node.js project, dependencies: react, typescript)
- Ran npm install (successful, 120 packages installed)

**Key Facts:**
- Project: React TypeScript app
- Node version: 18.x
- Build tool: Vite
- No errors encountered

**Files Modified:**
- src/App.tsx (added new component)
- package.json (added lodash dependency)`
}

// Messages 11-20 (recent) - KEEP FULL CONTEXT
[...full messages with thinking, tool_calls, tool results...]
```

**Compression Ratio:** ~40-50% reduction  
**Quality Retention:** ~95%

#### Strategy B: Compress Tool Results Only

Keep structure, summarize verbose data:

```typescript
// OLD (verbose)
{
  role: 'tool',
  tool_call_id: 'call_xyz',
  content: JSON.stringify({
    users: [/* 1000 user objects */],
    total: 1000
  })
}

// NEW (compressed)
{
  role: 'tool',
  tool_call_id: 'call_xyz',
  content: JSON.stringify({
    summary: 'Fetched 1000 users',
    sample: [/* first 3 user objects */],
    total: 1000,
    _compressed: true
  })
}
```

**Compression Ratio:** ~60-80% for large datasets  
**Quality Retention:** ~98% (critical structure preserved)

#### Strategy C: Remove Redundant Thinking

Keep "thought anchors", remove verbose reasoning:

```typescript
// OLD (verbose)
thinking: `Let me think about this step by step. First, I need to check if the file exists. Then I should read its contents. After that, I'll parse it as JSON. Then I'll look for the specific field...` (500 tokens)

// NEW (compressed)
thinking: `Plan: Check file → Read → Parse JSON → Find field` (15 tokens)
```

**Keep:** Planning sentences, uncertainty management, decision points  
**Remove:** Step-by-step obvious reasoning, repetitive thoughts

---

### Phase 3: Automatic Compaction (Future Enhancement)

Implement automatic context compression when approaching token limits:

```typescript
async function compactContext(messages: Message[]): Promise<Message[]> {
  const tokenCount = estimateTokens(messages);
  
  if (tokenCount < 50000) {
    return messages; // No compression needed
  }
  
  // Split into old (compress) and recent (keep full)
  const splitIndex = messages.length - 20;
  const oldMessages = messages.slice(0, splitIndex);
  const recentMessages = messages.slice(splitIndex);
  
  // Generate structured summary of old messages
  const summary = await generateStructuredSummary(oldMessages);
  
  return [
    { role: 'system', content: summary },
    ...recentMessages
  ];
}
```

**See:** OpenAI's [Compaction Guide](https://developers.openai.com/api/docs/guides/compaction) for implementation details

---

## Current Paprwork V2 Implementation

### ✅ What's Working

**Storage Layer:**
```typescript:573:591:src/gateway/services/AgentService.ts
const assistantMsg: StoredMessage = {
  thinking: thinkingText || undefined,  // ✅ Saved
  toolCalls: toolCalls.map(...),        // ✅ Saved
  content: assistantText,               // ✅ Saved
};
```

### ⚠️ What's Missing

**Context Building:**
```typescript:302:329:src/gateway/services/AgentService.ts
// Currently ONLY sending role + content
return { role, content };  // ❌ Excludes thinking and toolCalls!
```

---

## Recommended Fix for Paprwork V2

### Step 1: Include Tool Context in Messages

Update `AgentService.ts` to send full context to LLM:

```typescript
// CURRENT (lines 302-329)
return { role, content };

// RECOMMENDED
return {
  role,
  content,
  // Include thinking if present
  ...(msg.thinking && { 
    // For reasoning models that support it
    reasoning: msg.thinking 
  }),
  // Include tool calls if present
  ...(msg.toolCalls && msg.toolCalls.length > 0 && {
    tool_calls: msg.toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.args)
      }
    }))
  })
};
```

### Step 2: Include Tool Results as Separate Messages

After assistant messages with tool calls, add tool result messages:

```typescript
// After each assistant message with tool calls
for (const toolCall of msg.toolCalls || []) {
  if (toolCall.result) {
    messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      name: toolCall.name,
      content: toolCall.result
    });
  }
}
```

### Step 3: Add Compression Threshold (Future)

```typescript
// In loadMessagesForLLM
const MAX_TOKENS = 50000;
const tokenCount = estimateTokens(messages);

if (tokenCount > MAX_TOKENS) {
  // Trigger compression
  messages = await this.compactMessages(chatId, messages);
}
```

---

## Testing Strategy

### Quality Metrics
- ✅ **Multi-turn coherence:** Can model reference previous tool results?
- ✅ **Error recovery:** Does model avoid repeating failed commands?
- ✅ **Context awareness:** Can model see what data it already fetched?

### Cost Metrics
- ✅ **Token usage per turn:** Target < 10K tokens per request
- ✅ **Compression ratio:** Target 40-50% reduction after compression
- ✅ **Monthly cost:** Monitor average tokens per conversation

### Test Cases
1. **Multi-step workflow:** "List files, read package.json, install dependencies"
   - Should reference previous ls output
   - Shouldn't re-list files
2. **Error recovery:** "Run invalid command, then fix it"
   - Should learn from error message
   - Shouldn't repeat same mistake
3. **Long conversation:** 30+ turns with 10+ tool calls
   - Should compress old context
   - Should retain critical facts

---

## References

1. **OpenAI Function Calling Docs** (2026): https://platform.openai.com/docs/guides/function-calling
2. **Anthropic Context Management** (2025): https://docs.anthropic.com/en/docs/claude-code/costs
3. **Acon Framework** (ArXiv 2025): 26-54% compression with 95%+ accuracy retention
4. **SWE-Pruner** (ArXiv 2026): 23-54% reduction for coding agents
5. **Factory.ai Probe Evaluation** (2025): Structured summaries outperform raw summaries
6. **Chain-of-Thought Research** (ArXiv 2022-2025): Full reasoning traces improve performance

---

## Action Items for Paprwork V2

### Immediate (Phase 1)
- [ ] Update `AgentService.ts` to include tool calls and tool results in context
- [ ] Test multi-turn tool usage (verify model sees previous results)
- [ ] Monitor token usage per conversation

### Short-term (Phase 2)
- [ ] Implement token estimation function
- [ ] Add compression threshold (50K tokens)
- [ ] Implement structured summarization for old messages

### Long-term (Phase 3)
- [ ] Automatic compaction when approaching limits
- [ ] User-configurable compression settings
- [ ] Cost analytics dashboard

---

**Last Updated:** 2026-02-12  
**Next Review:** After implementing Phase 1 changes
