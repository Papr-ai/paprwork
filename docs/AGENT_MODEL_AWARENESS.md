# Agent Model Awareness - Gap Analysis

**Date:** 2026-02-17  
**Issue:** Agent doesn't know what models are available when creating sub-agents  
**Status:** 🔴 Information Gap Found

---

## Current State

### What the Agent Sees

When creating sub-agents with `create_sub_agent`, the agent receives a **Zod schema** that defines the tool parameters:

```typescript
// From src/core/tools/delegation.ts
const createSubAgentSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  systemPrompt: z.string().min(1),
  provider: z.enum(["anthropic", "openai", "google"]).optional(),  // ← Shows 3 options
  model: z.string().min(1).optional(),                              // ← Just "string", no specific values!
  allowedToolIds: z.array(z.string().min(1)).optional(),
  // ... other fields
});
```

**What the agent learns from this:**
- ✅ Provider can be: `"anthropic"`, `"openai"`, or `"google"`
- ❌ Model: Just knows it's a string - **NO LIST OF VALID MODEL IDs**

### What the Agent DOESN'T See

The agent has **NO INFORMATION** about:
- ❌ What model IDs are valid for each provider
- ❌ Which models support thinking/reasoning
- ❌ Which models are faster vs more capable
- ❌ Model naming conventions (e.g., `claude-sonnet-4-5` not `claude-sonnet-4.5`)
- ❌ Model capabilities (context windows, vision support, etc.)

---

## System Prompt Analysis

### Current Documentation

**File:** `src/core/agents/SystemPrompt.ts`

The system prompt includes examples of `create_sub_agent`, but **none mention `provider` or `model` fields**:

```javascript
// Example from SystemPrompt (lines 897-902)
create_sub_agent({
  name: "data-processor",
  description: "Processes SQLite data",
  systemPrompt: "Read from data.db and analyze..."
  // ❌ No provider field shown
  // ❌ No model field shown
  // allowedToolIds defaults to ["bash", "read_file", "write_file"]
})
```

**All examples omit provider/model fields**, implying the agent should use defaults.

---

## Current Behavior

### What Happens When Agent Creates Sub-Agent

**Scenario 1: Agent doesn't specify model**
```javascript
create_sub_agent({
  name: "researcher",
  systemPrompt: "Research topics..."
})
// Result: Defaults to openai/gpt-5-mini
```

**Scenario 2: Agent guesses a model name**
```javascript
create_sub_agent({
  name: "researcher",
  provider: "anthropic",
  model: "claude-3-opus"  // ❌ Wrong! Should be "claude-opus-4-5"
})
// Result: Unknown - may fail or fall back to default
```

**Scenario 3: Agent uses correct model ID (by luck or prior knowledge)**
```javascript
create_sub_agent({
  name: "researcher",
  provider: "anthropic",
  model: "claude-opus-4-5-thinking"  // ✅ Correct!
})
// Result: Works as intended
```

---

## Problem Impact

### Low Impact (Current)
- Most sub-agents work fine with default `gpt-5-mini`
- Agent rarely tries to specify models
- System prompt examples don't show model selection

### Medium Impact (If Agent Tries)
- Agent might guess wrong model names
- Agent doesn't know which models have thinking capability
- Agent can't optimize for speed vs capability

### High Impact (Advanced Use Cases)
- Agent can't create specialized sub-agents with optimal models
- No way to create cost-optimized vs performance-optimized agents
- Can't leverage model-specific capabilities

---

## Solutions

### Option 1: Document Available Models in System Prompt ⭐ RECOMMENDED

Add a section to `SystemPrompt.ts` listing available models:

```typescript
## Available Models for Sub-Agents

When creating sub-agents, you can optionally specify \`provider\` and \`model\`.

**If not specified:** Defaults to \`openai\` / \`gpt-5-mini\` (fast, cost-effective)

### Anthropic Claude Models
- \`claude-haiku-4-5\` - Fastest, best for simple tasks
- \`claude-sonnet-4-5\` - Balanced speed and capability (default for Anthropic)
- \`claude-opus-4-5\` - Most capable, best for complex reasoning
- \`claude-opus-4-5-thinking\` - Extended thinking for deep analysis

### OpenAI GPT Models
- \`gpt-5-mini\` - Fast, efficient (default for OpenAI) ⭐ RECOMMENDED
- \`gpt-5-2\` - More capable, balanced reasoning
- \`gpt-5-2-low\` - Lower reasoning effort (faster)
- \`gpt-5-2-high\` - Higher reasoning effort (slower, more thorough)
- \`gpt-5-2-xhigh\` - Maximum reasoning effort
- \`gpt-5-2-codex\` - Specialized for code tasks

### Google Gemini Models
- \`gemini-2-5-flash\` - Fast, capable (default for Google)
- \`gemini-2-5-flash-lite\` - Lightweight, very fast
- \`gemini-3-flash-preview\` - Latest, experimental
- \`gemini-3-pro-preview\` - Most capable, experimental

### Example: Create sub-agent with specific model

\`\`\`javascript
// Use default (gpt-5-mini)
create_sub_agent({
  name: "fast-processor",
  systemPrompt: "Process data quickly..."
})

// Use powerful model for complex reasoning
create_sub_agent({
  name: "deep-researcher",
  provider: "anthropic",
  model: "claude-opus-4-5-thinking",
  systemPrompt: "Perform deep research..."
})

// Use code-specialized model
create_sub_agent({
  name: "code-generator",
  provider: "openai",
  model: "gpt-5-2-codex",
  systemPrompt: "Generate production code..."
})
\`\`\`

**Guidelines:**
- **Fast tasks:** Use \`gpt-5-mini\` (default)
- **Complex reasoning:** Use \`claude-opus-4-5-thinking\` or \`gpt-5-2-xhigh\`
- **Code tasks:** Use \`gpt-5-2-codex\`
- **Cost-sensitive:** Use \`gpt-5-mini\` or \`claude-haiku-4-5\`
```

**Pros:**
- ✅ Agent has clear guidance
- ✅ Shows proper model ID format
- ✅ Explains trade-offs
- ✅ Easy to maintain (just text)

**Cons:**
- ❌ Need to update when new models added
- ❌ Increases system prompt length

---

### Option 2: Create `list_available_models` Tool

Add a new tool to query available models:

```typescript
export const listAvailableModelsTool = createTool({
  id: "list_available_models",
  description: "Get list of available AI models for sub-agents and chat",
  inputSchema: z.object({
    provider: z.enum(["anthropic", "openai", "google", "all"]).optional()
  }),
  execute: async (input) => {
    const args = input.context ?? input;
    const { CHAT_MODELS } = await import("../../ui/constants/models.js");
    
    const models = args.provider && args.provider !== "all"
      ? CHAT_MODELS.filter(m => m.provider === args.provider)
      : CHAT_MODELS;
    
    return {
      success: true,
      data: {
        models: models.map(m => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          description: m.description,
          supportsThinking: m.supportsThinking,
          maxTokens: m.maxTokens
        }))
      }
    };
  }
});
```

**Pros:**
- ✅ Always up-to-date (reads from `models.ts`)
- ✅ Agent can query on-demand
- ✅ Provides structured data

**Cons:**
- ❌ Adds tool call overhead
- ❌ Agent needs to know to call it
- ❌ More complex implementation

---

### Option 3: Hybrid Approach ⭐ BEST

Combine both approaches:

1. **Document common models** in system prompt (fast reference)
2. **Add `list_available_models` tool** (complete list, always current)

**System Prompt:**
```
Common models (use list_available_models for full list):
- gpt-5-mini (default, fast)
- claude-opus-4-5-thinking (powerful)
- gpt-5-2-codex (code tasks)
```

**Agent can:**
- Use common models immediately (no tool call)
- Query full list when needed
- Get latest models automatically

---

## Recommendation

### Implement Option 1 First (System Prompt Documentation)

**Why:**
- Simple to implement (just text)
- Solves immediate problem
- No new tool needed
- Agent rarely needs full model list

**Add to SystemPrompt.ts:**
1. New section: "Available Models for Sub-Agents"
2. List all current models with brief descriptions
3. Show examples with different models
4. Explain when to use each model type

### Later: Add Option 2 (Tool) if Needed

If we find:
- Models change frequently
- Agent often needs full list
- Advanced use cases require querying capabilities

Then add `list_available_models` tool.

---

## Implementation

### Step 1: Add Model Documentation

**Location:** `src/core/agents/SystemPrompt.ts`

**Where to add:** After "Sub-Agent Creation Requirements" section (line ~925)

**Content:** Full model list with descriptions and examples

### Step 2: Update Examples

**Current examples** (lines 897-916) don't show `provider`/`model` fields.

**Add new examples showing:**
- Using default model
- Specifying specific model for power
- Specifying model for speed
- Model selection based on task type

---

## Summary

### Current State
- ❌ Agent doesn't know what models are available
- ❌ Schema only shows `model: string` (no valid values)
- ❌ System prompt examples don't mention models
- ✅ Provider enum shows 3 options (anthropic, openai, google)

### Impact
- 🟡 Medium - Agent uses defaults (works but not optimal)
- 🔴 High if agent tries to specify models (might guess wrong)

### Solution
1. **Document models in system prompt** (recommended)
2. Add `list_available_models` tool (future)
3. Update examples to show model selection

### Priority
**HIGH** - Prevents agent from guessing wrong model names and enables optimization

---

## Next Steps

1. Add "Available Models" section to `SystemPrompt.ts`
2. Update `create_sub_agent` examples to show model selection
3. Test agent's ability to choose appropriate models
4. Monitor if agent makes good model choices
5. Consider adding `list_available_models` tool if needed
