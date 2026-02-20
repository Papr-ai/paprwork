# Paprwork V1 Summarization - Key Insights for V2

## What V1 Does Well ✅

### 1. Multi-Tier Thresholds
```
35K tokens → Preemptive summarization (before next turn)
50K tokens → Aggressive summarization
168K tokens → Emergency truncation
```

**Insight**: Don't wait until context is full. Start early at 35-40K.

### 2. Retention Strategy
```
Target after summarization: 30K tokens
Recent retention: 60-70% of target (18-21K for recent messages)

CRITICAL: Always keep from last user message onward!
```

**Insight**: Recent messages must stay intact. Old messages get summarized.

### 3. Structured Summary Format

V1 uses **structured sections** for the summary:

```markdown
CURRENT_FOCUS – What is happening right now
RECENT_CHANGES – Files/code just modified  
SESSION_INTENT – Overall goal (1–2 sentences)
FILES_ACCESSED – Modified / read / created
KEY_DECISIONS – Bullet points
TRIED_AND_FAILED – What did not work
NEXT_STEPS – What to do next
IMPORTANT_DETAILS – Errors, function names, APIs, config
```

**Insight**: Structure helps LLM navigate. Much better than unstructured paragraph.

### 4. Summary Merging

When summary already exists, **merge old + new summary**:
```
Existing: Old summary
New: Summary of messages since last summary
Merged: Combined, deduplicated, most current info wins
```

**Insight**: Don't re-summarize from scratch. Merge incrementally.

### 5. Strong Framing

The summary is injected with **strong instructions**:
```markdown
[ARCHIVED CONVERSATION HISTORY - SUMMARY]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 HISTORICAL CONTEXT (X messages archived)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ IMPORTANT INSTRUCTIONS:
• DO NOT respond to this summary
• DO NOT ask clarifying questions about the summary
• DO NOT re-do work mentioned as completed
• INSTEAD: Focus on the RECENT MESSAGES below

<summary content>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[END OF ARCHIVED CONTEXT]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The following N messages represent the RECENT conversation.
Your task is to respond to the MOST RECENT user message.
```

**Insight**: Clear framing prevents LLM from treating summary as active conversation.

---

## What V1 Does Poorly ❌

### 1. Model Choice Issues

**Problem**: Uses `gpt-5-mini` which may not exist
```javascript
model: 'gpt-5-mini',  // Main process
model: 'gpt-5.2',     // Fallback
model: 'claude-sonnet-4-5'  // Gateway
```

**For V2**: Use models we know exist:
- `gpt-5.2-low` (fast, cheap, exists)
- `claude-haiku-4-5` (fast, cheap, exists)

### 2. Dual File System

**Problem**: `{id}.jsonl` + `{id}_llm.jsonl` causes:
- Orphaned files
- Stale data
- Complexity

**For V2**: Single SQLite database with `is_compressed` flag.

### 3. Empty Summary Bug

**Problem**: API sometimes returns empty summary (between markers)

**For V2**: 
- Validate summary before saving
- Fallback to last good summary
- Log failures

### 4. Multiple Summarization Triggers

**Problem**: Can trigger multiple times per turn:
- Pre-turn check
- Post-response check
- Manual trigger
- Emergency trigger

**For V2**: Single clear trigger with `summarizedThisTurn` flag.

---

## Recommended V2 Approach

### Thresholds (from V1)
```typescript
const THRESHOLDS = {
  PREEMPTIVE: 35_000,    // Start thinking about summarization
  TRIGGER: 50_000,       // Actually summarize
  EMERGENCY: 150_000,    // Hard limit (most models ~200K context)
  TARGET_AFTER: 30_000,  // Target tokens after summarization
  RETENTION_RATE: 0.7,   // Keep 70% for recent messages (21K)
};
```

### Summary Structure (improved from V1)
```typescript
interface StructuredSummary {
  // What's happening (like V1)
  current_focus: string;
  session_intent: string;  // 1-2 sentences
  
  // Technical details (like V1)
  files_accessed: {
    modified: string[];
    read: string[];
    created: string[];
  };
  
  // Thinking (NEW - not in V1!)
  key_reasoning: string[];  // Important thinking/reasoning
  
  // Decisions (like V1)
  key_decisions: string[];
  tried_and_failed: string[];
  
  // What's next (like V1)
  next_steps: string[];
  
  // Context (like V1)
  important_details: {
    errors: string[];
    apis_used: string[];
    tool_calls: string[];  // What tools were used
  };
}
```

### Prompt Template (based on V1)
```typescript
const SUMMARIZATION_PROMPT = `Create a structured summary of this conversation.

CONVERSATION TO SUMMARIZE (${messageCount} messages):
${conversationText}

${existingSummary ? `EXISTING SUMMARY TO MERGE WITH:
${existingSummary}

MERGE INSTRUCTIONS:
- Combine information from both summaries
- Keep all key decisions, failures, and reasoning
- Update files_accessed with new files
- Use most current focus and intent
- Deduplicate identical entries
` : ''}

OUTPUT FORMAT (JSON):
{
  "current_focus": "What is happening right now in 1-2 sentences",
  "session_intent": "Overall goal in 1 sentence",
  "files_accessed": {
    "modified": ["file paths"],
    "read": ["file paths"],
    "created": ["file paths"]
  },
  "key_reasoning": ["Important thinking/reasoning insights"],
  "key_decisions": ["Bullet points of decisions made"],
  "tried_and_failed": ["What didn't work and why"],
  "next_steps": ["What to do next"],
  "important_details": {
    "errors": ["Error messages encountered"],
    "apis_used": ["APIs/services used"],
    "tool_calls": ["Tools executed and their purpose"]
  }
}

IMPORTANT:
- Be comprehensive but concise
- Preserve technical details (code, errors, APIs)
- Include reasoning/thinking insights
- List all files accessed
- Note failed approaches to avoid retrying`;
```

### Injection Format (based on V1, improved)
```typescript
const summaryMessage = {
  role: 'user',
  content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 ARCHIVED CONVERSATION SUMMARY (${archivedCount} messages)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This is background context from earlier in our conversation.

⚠️  CRITICAL INSTRUCTIONS:
• DO NOT respond to or ask questions about this summary
• DO NOT re-do work mentioned as completed
• DO NOT revisit tried-and-failed approaches
• FOCUS on the ${recentCount} RECENT messages below

───────────────────────────────────────────────────────────

📍 CURRENT FOCUS
${summary.current_focus}

🎯 SESSION INTENT
${summary.session_intent}

📁 FILES ACCESSED
Modified: ${summary.files_accessed.modified.join(', ')}
Read: ${summary.files_accessed.read.join(', ')}
Created: ${summary.files_accessed.created.join(', ')}

💡 KEY REASONING
${summary.key_reasoning.map(r => `• ${r}`).join('\n')}

✅ KEY DECISIONS
${summary.key_decisions.map(d => `• ${d}`).join('\n')}

❌ TRIED AND FAILED
${summary.tried_and_failed.map(f => `• ${f}`).join('\n')}

📋 NEXT STEPS
${summary.next_steps.map(s => `• ${s}`).join('\n')}

🔧 IMPORTANT DETAILS
Errors: ${summary.important_details.errors.join(', ')}
APIs: ${summary.important_details.apis_used.join(', ')}
Tools: ${summary.important_details.tool_calls.join(', ')}

───────────────────────────────────────────────────────────

You can search full history using the search_history tool.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[END OF ARCHIVED CONTEXT]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The following ${recentCount} messages are the RECENT conversation.
Respond to the MOST RECENT user message.`
};
```

---

## Implementation for V2

### 1. When to Summarize

```typescript
class CompactionService {
  private summarizedChats = new Set<string>();
  
  async checkAndSummarize(chatId: string) {
    // Prevent multiple summarizations per turn
    if (this.summarizedChats.has(chatId)) {
      return;
    }
    
    const stats = await this.storage.getChatStats(chatId);
    
    // V1 thresholds
    if (stats.tokenCount < 35_000) {
      return; // Not yet
    }
    
    if (stats.tokenCount > 50_000) {
      // Definitely summarize
      await this.summarize(chatId);
      this.summarizedChats.add(chatId);
      
      // Clear flag after turn
      setTimeout(() => this.summarizedChats.delete(chatId), 5000);
    }
  }
}
```

### 2. Summarization Method

```typescript
async summarize(chatId: string) {
  // 1. Load all messages
  const allMessages = await this.storage.loadAllMessages(chatId);
  
  // 2. Calculate retention (V1 strategy)
  const totalTokens = allMessages.reduce((sum, m) => sum + m.token_count, 0);
  const targetRecent = Math.floor(30_000 * 0.7); // 21K for recent
  
  // 3. Find split point (keep from last user message onward!)
  let recentMessages = [];
  let recentTokens = 0;
  let lastUserIndex = -1;
  
  // Find last user message
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  
  // Keep messages from last user onward + additional based on token budget
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    const isFromLastUser = i >= lastUserIndex;
    
    if (recentTokens + msg.token_count <= targetRecent || isFromLastUser) {
      recentMessages.unshift(msg);
      recentTokens += msg.token_count;
    } else {
      break;
    }
  }
  
  // 4. Messages to summarize
  const toSummarize = allMessages.slice(0, allMessages.length - recentMessages.length);
  
  if (toSummarize.length < 5) {
    return; // Not enough to summarize
  }
  
  // 5. Get existing summary (for merging)
  const existingSummary = await this.storage.getLatestSummary(chatId);
  
  // 6. Generate structured summary
  const summary = await this.generateStructuredSummary(
    toSummarize,
    existingSummary
  );
  
  // 7. Validate summary (prevent empty summary bug)
  if (!summary || !summary.current_focus) {
    console.error('❌ Empty summary generated, keeping last good summary');
    return;
  }
  
  // 8. Save summary
  await this.storage.saveSummary(chatId, {
    summary_data: JSON.stringify(summary),
    first_message_id: toSummarize[0].id,
    last_message_id: toSummarize[toSummarize.length - 1].id,
    message_count: toSummarize.length,
  });
  
  // 9. Mark messages as compressed
  await this.storage.markMessagesCompressed(toSummarize.map(m => m.id));
  
  console.log(`✅ Summarized ${toSummarize.length} messages, kept ${recentMessages.length} recent`);
}

private async generateStructuredSummary(
  messages: any[],
  existingSummary?: any
): Promise<StructuredSummary> {
  const summaryAgent = new Agent({
    model: 'openai/gpt-5.2-low', // Fast and cheap
    instructions: 'You create structured conversation summaries in JSON format.',
  });
  
  const conversationText = messages
    .map(m => this.formatMessageForSummary(m))
    .join('\n\n');
  
  const result = await summaryAgent.generate(
    SUMMARIZATION_PROMPT
      .replace('${messageCount}', messages.length.toString())
      .replace('${conversationText}', conversationText.substring(0, 50000))
      .replace('${existingSummary}', existingSummary ? JSON.stringify(existingSummary.summary_data) : '')
  );
  
  try {
    return JSON.parse(result.text);
  } catch (e) {
    console.error('Failed to parse summary JSON:', e);
    throw new Error('Invalid summary format');
  }
}

private formatMessageForSummary(msg: any): string {
  let text = `[${msg.role}]: ${msg.content}`;
  
  if (msg.reasoning) {
    text += `\n[Thinking]: ${msg.reasoning}`;
  }
  
  if (msg.toolCalls) {
    text += `\n[Tools]: ${msg.toolCalls.map(t => 
      `${t.toolName}(${JSON.stringify(t.args)}) → ${t.result?.substring(0, 200)}`
    ).join(', ')}`;
  }
  
  return text;
}
```

### 3. Loading with Summary

```typescript
async loadMessagesForLLM(chatId: string): Promise<any[]> {
  const allMessages = await this.loadAllMessages(chatId);
  
  // Get uncompressed messages
  const recentMessages = allMessages.filter(m => !m.is_compressed);
  
  // Get latest summary
  const summaryRow = await this.getLatestSummary(chatId);
  
  if (!summaryRow) {
    // No summary yet, return all messages
    return allMessages;
  }
  
  // Parse structured summary
  const summary: StructuredSummary = JSON.parse(summaryRow.summary_data);
  
  // Build context: summary + recent + search tool
  return [
    this.formatSummaryMessage(summary, allMessages.length - recentMessages.length, recentMessages.length),
    ...recentMessages,
  ];
}
```

---

## Key Takeaways for V2

1. ✅ **Use V1's thresholds**: 35K preemptive, 50K trigger, 30K target
2. ✅ **Use V1's retention**: 70% for recent, always keep from last user message
3. ✅ **Use V1's structured format**: Sections are better than paragraphs
4. ✅ **Use V1's merging**: Merge summaries incrementally
5. ✅ **Use V1's framing**: Strong instructions prevent LLM confusion
6. ❌ **Fix V1's bugs**: Use real models, validate output, single trigger
7. ➕ **Add improvements**: JSON format, key_reasoning section, search tool

**Result**: V1's proven strategy + V2's simplifications + new features! 🎯
