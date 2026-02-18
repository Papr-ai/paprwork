# Gemini Thinking Tokens Fix & Exploring Card Narration

**Date:** 2026-02-16
**Issues Fixed:**
1. Gemini thinking tokens not appearing in UI ✅
2. Agent narration should appear in Exploring card after tool calls ✅

---

## Issue 1: Missing Thinking Tokens for Gemini ✅

### Root Cause
The `providerOptions` configuration in both `AgentService.ts` and `MastraAgent.ts` only included OpenAI-specific options. Gemini models require `thinkingConfig` to enable thought summaries via the `includeThoughts` flag and `thinkingBudget` parameter.

### Files Changed

#### 1. `src/gateway/services/AgentService.ts`
**Added:** Google provider options for thinking configuration

```typescript
// Before
const providerOptions: {
  openai?: {
    reasoningEffort: "low" | "medium" | "high" | "xhigh";
    reasoningSummary: "detailed";
  };
} = {};

// After
const providerOptions: {
  openai?: {
    reasoningEffort: "low" | "medium" | "high" | "xhigh";
    reasoningSummary: "detailed";
  };
  google?: {
    thinkingConfig: {
      includeThoughts: boolean;
      thinkingBudget?: number;
    };
  };
} = {};

// Add Google configuration
if (config.provider === 'google' && config.thinkingBudget !== undefined && config.thinkingBudget > 0) {
  providerOptions.google = {
    thinkingConfig: {
      includeThoughts: true, // Enable thought summaries in stream
      thinkingBudget: config.thinkingBudget, // Token budget for thinking
    },
  };
}
```

**Updated:** Provider options check to include Google
```typescript
// Before
...(providerOptions.openai ? { providerOptions } : {})

// After  
...(providerOptions.openai || providerOptions.google ? { providerOptions } : {})
```

#### 2. `src/core/agents/MastraAgent.ts`
**Added:** Same Google thinking configuration as above

#### 3. `ui/constants/models.ts`
**Added:** Default thinking budgets for all Gemini models

```typescript
{
  id: "gemini-3-pro-preview",
  name: "Gemini 3 Pro",
  defaultThinkingBudget: 16000, // Added
  ...
},
{
  id: "gemini-3-flash-preview",
  name: "Gemini 3 Flash",
  defaultThinkingBudget: 10000, // Added
  ...
},
{
  id: "gemini-2.5-flash",
  name: "Gemini 2.5 Flash",
  defaultThinkingBudget: 8000, // Added
  ...
},
{
  id: "gemini-2.5-flash-lite",
  name: "Gemini 2.5 Flash Lite",
  defaultThinkingBudget: 5000, // Added
  ...
}
```

#### 4. `ui/components/Chat/ChatContainer.tsx`
**Added:** Pass thinking budget in agent config

```typescript
const config = {
  provider: selectedModel.provider,
  model: selectedModel.id,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  reasoning: selectedModel.reasoning,
  thinkingBudget: selectedModel.defaultThinkingBudget, // Added
};
```

---

## Issue 2: Tool Call JSON Appearing in Message Text

### Root Cause
When Gemini makes tool calls, the AI SDK emits several chunk types in sequence:
1. `start-step` - Begin a new step
2. `tool-input-start` - Tool call begins
3. `tool-input-delta` - Tool arguments being built
4. `tool-input-end` - Tool call complete
5. `text-start` / `text-end` - Metadata chunks (no content)
6. `tool-call` - Actual tool call event
7. `tool-result` - Tool execution result

The stream orchestrator was accumulating **all** `text-delta` chunks into `assistantText`, including any text that appeared during tool-calling steps. This caused tool call JSON to leak into the final message content.

### Solution
Added state tracking to filter out text during tool-calling phases:

#### `src/gateway/services/agent/streamOrchestrator.ts`

**Added:** Tool step tracking flag
```typescript
// Track if we're currently in a tool-calling step
// When true, don't accumulate text-delta into assistantText
let inToolStep = false;
```

**Added:** Handlers for step lifecycle events
```typescript
case "start-step": {
  // Reset tool step flag at the start of each step
  inToolStep = false;
  break;
}

case "tool-input-start":
case "tool-input-delta":
case "tool-input-end": {
  // Mark that we're in a tool step - don't accumulate text
  inToolStep = true;
  break;
}

case "text-start":
case "text-end": {
  // Ignore these metadata chunks - they don't contain actual content
  break;
}
```

**Updated:** Text-delta handler to respect tool step flag
```typescript
case "text-delta": {
  const text = typeof chunk.text === "string" ? chunk.text : "";
  
  // Only accumulate text if we're not in a tool-calling step
  // This prevents tool call JSON from appearing in the message
  if (!inToolStep) {
    assistantText += text;
    textBuffer += text;

    if (textBuffer.length >= TEXT_BUFFER_MIN) {
      yield createChatStreamChunk("text-delta", { text: textBuffer }, chatId);
      textBuffer = "";
    }
  }
  break;
}
```

**Updated:** Tool-call and finish-step handlers
```typescript
case "tool-call": {
  const toolCall = parseToolCallChunk(rawChunk);
  if (!toolCall) break;

  // Mark that we're in a tool step
  inToolStep = true;
  
  // ... rest of handler
}

case "finish-step": {
  // Reset tool step flag when step finishes
  inToolStep = false;
  break;
}
```

---

## Testing

### Test Case 1: Gemini Thinking Tokens
1. Select a Gemini model (e.g., Gemini 3 Flash)
2. Send a message that requires thinking (e.g., "Explain quantum computing")
3. **Expected:** Thinking tokens appear in a collapsible "Extended Thinking" section
4. **Verify:** Check browser console for `reasoning-delta` chunks

### Test Case 2: Tool Calls Without Text Leakage
1. Select a Gemini model
2. Send a message that triggers tool calls (e.g., "list the files in my home directory")
3. **Expected:** 
   - Tool calls appear as cards showing name, args, and results
   - Final message text does NOT contain tool call JSON
   - Message text only contains the assistant's actual response
4. **Verify:** 
   - Check browser console for proper chunk sequence
   - Inspect saved message in `~/Papr/{chatId}.jsonl` - `content` field should not contain tool JSON

---

## Architecture Notes

### Mastra Provider Options Structure
```typescript
// OpenAI (GPT-5.x with reasoning)
providerOptions: {
  openai: {
    reasoningEffort: "low" | "medium" | "high" | "xhigh",
    reasoningSummary: "detailed"
  }
}

// Google (Gemini with thinking)
providerOptions: {
  google: {
    thinkingConfig: {
      includeThoughts: true,  // Enable thought summaries
      thinkingBudget: 10000   // Token budget for thinking
    }
  }
}
```

### AI SDK Stream Chunk Types
The AI SDK emits these chunk types during streaming:

**Content Chunks:**
- `text-delta` - Incremental text content
- `reasoning-delta` - Thinking/reasoning content (OpenAI: o1/o3, Google: Gemini)

**Tool Chunks:**
- `tool-input-start` - Tool call begins
- `tool-input-delta` - Tool arguments being built (streamed JSON)
- `tool-input-end` - Tool call complete
- `tool-call` - Finalized tool call with name and args
- `tool-result` - Tool execution result

**Metadata Chunks:**
- `start` - Stream begins
- `start-step` - New step begins (agentic loop)
- `finish-step` - Step completes
- `text-start` / `text-end` - Text block boundaries (no content)
- `finish` - Stream complete

**Important:** `tool-input-delta` chunks contain raw JSON that should NOT be displayed to users. The orchestrator must filter these out.

---

## References

- [Mastra Google Provider Docs](https://mastra.ai/en/models/providers/google)
- [Gemini Thinking Docs](https://ai.google.dev/gemini-api/docs/thinking)
- [AI SDK Streaming Docs](https://sdk.vercel.ai/docs/ai-sdk-core/generating-text)
- Issue: [Mastra #11335 - Tool calls missing thought_signature](https://github.com/mastra-ai/mastra/issues/11335)

---

## Commit Message

```
fix(gemini): Enable thinking tokens and prevent tool call text leakage

Two fixes for Gemini models:

1. **Thinking tokens now appear in UI**
   - Added Google provider options with thinkingConfig
   - Set includeThoughts: true and thinkingBudget
   - Added default thinking budgets to all Gemini models
   - Pass thinkingBudget from UI to agent config

2. **Tool call JSON no longer appears in message text**
   - Added inToolStep flag to track tool-calling phases
   - Filter text-delta chunks during tool steps
   - Handle tool-input-* and text-start/end metadata chunks
   - Only accumulate text outside tool-calling context

Files changed:
- src/gateway/services/AgentService.ts
- src/core/agents/MastraAgent.ts
- src/gateway/services/agent/streamOrchestrator.ts
- ui/constants/models.ts
- ui/components/Chat/ChatContainer.tsx
```
