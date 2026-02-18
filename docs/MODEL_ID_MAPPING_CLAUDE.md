# Model ID Mapping - Claude Sonnet 4.5

**Date:** 2026-02-17  
**Question:** When user picks "claude-sonnet-4-5" in UI, what model gets used?

---

## Answer: Exactly `claude-sonnet-4-5`

When a user selects **"Claude Sonnet 4.5"** in the UI, the system sends the model ID `claude-sonnet-4-5` **directly to the Anthropic API** with no transformation.

---

## Flow Breakdown

### 1. UI Model Definition

**File:** `ui/constants/models.ts`

```typescript
{
  id: "claude-sonnet-4-5",           // ← This is what gets sent
  name: "Claude Sonnet 4.5",         // ← Display name in UI
  provider: "anthropic",
  description: "Fast and capable, good balance of speed and quality",
  supportsThinking: true,
  defaultThinkingBudget: 10000,
  maxTokens: 8192,
}
```

### 2. User Selects Model

**File:** `ui/components/Chat/ChatContainer.tsx`

```typescript
const [selectedModel, setSelectedModel] = useState<AIModel>(
  CHAT_MODELS.find((m) => m.id === "claude-sonnet-4-5") || CHAT_MODELS[0]
);

// When sending message:
const config: AgentConfig = {
  provider: selectedModel.provider,    // "anthropic"
  model: selectedModel.id,             // "claude-sonnet-4-5"
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  reasoning: selectedModel.reasoning,
  thinkingBudget: selectedModel.defaultThinkingBudget,
  maxTokens: selectedModel.maxTokens,
};
```

### 3. Gateway Creates Model Instance

**File:** `src/gateway/services/ChatSessionManager.ts`

```typescript
switch (config.provider) {
  case 'anthropic':
    model = anthropic(config.model);  // ← anthropic("claude-sonnet-4-5")
    break;
  // ... other providers
}
```

**No transformation happens for Anthropic models!**

### 4. API Call to Anthropic

The Mastra SDK (which wraps the AI SDK) calls the Anthropic API with:

```json
{
  "model": "claude-sonnet-4-5",
  "max_tokens": 8192,
  "messages": [...],
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

---

## Comparison: Anthropic vs OpenAI Model Mapping

### Anthropic (NO mapping)

```
UI Model ID          → API Model ID
────────────────────────────────────
claude-sonnet-4-5   → claude-sonnet-4-5 (direct, no change)
claude-opus-4-5     → claude-opus-4-5   (direct, no change)
claude-haiku-4-5    → claude-haiku-4-5  (direct, no change)
```

**Why no mapping?** Each Anthropic model has a unique API identifier.

---

### OpenAI (HAS mapping for reasoning variants)

```
UI Model ID          → API Model ID + Options
─────────────────────────────────────────────────────────
gpt-5-2             → gpt-5-2 (reasoning: medium)
gpt-5-2-low         → gpt-5-2 (reasoning: low)
gpt-5-2-high        → gpt-5-2 (reasoning: high)
gpt-5-2-xhigh       → gpt-5-2 (reasoning: xhigh)
gpt-5-2-codex       → gpt-5-2-codex (no mapping, separate model)
gpt-5-mini          → gpt-5-mini (no mapping, separate model)
```

**Why mapping?** OpenAI uses the same base model (`gpt-5-2`) with different reasoning effort levels.

**Code:**
```typescript
// src/gateway/services/ChatSessionManager.ts (lines 93-99)
let normalizedModel = config.model;
if (config.model.startsWith('gpt-5-2-')) {
  normalizedModel = 'gpt-5-2';  // ← Map variants to base model
}
```

---

## Verification

### What Actually Gets Sent to Anthropic API?

Based on the code flow:

1. **UI sends:** `model: "claude-sonnet-4-5"`
2. **Gateway receives:** `config.model = "claude-sonnet-4-5"`
3. **Mastra SDK calls:** `anthropic("claude-sonnet-4-5")`
4. **API receives:** `{ "model": "claude-sonnet-4-5", ... }`

**No transformation at any step.**

---

## Is This the Correct Model ID?

### ⚠️ Potential Issue: Anthropic API Model Naming

Anthropic's actual API model identifiers typically use **date-based versioning**:

**Example from Anthropic docs (as of recent versions):**
- `claude-3-5-sonnet-20241022`
- `claude-3-opus-20240229`
- `claude-sonnet-4-20250514`

**Our code uses:**
- `claude-sonnet-4-5`

### Questions to Verify:

1. **Does `claude-sonnet-4-5` resolve to the latest Sonnet 4?**
   - Anthropic may support version-less aliases like `claude-sonnet-4` → latest
   - Or they may require explicit date versions

2. **Is this causing API errors?**
   - Check if API calls are succeeding
   - Or if they're falling back to default/alias

3. **Should we use date-based versions?**
   - Pros: Explicit, guaranteed to work
   - Cons: Need to update when new versions release

---

## Recommendation: Verify with Anthropic API

### Test What Model ID Works

```bash
# Test if claude-sonnet-4-5 works
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hi"}]
  }'

# Test with date version
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hi"}]
  }'
```

### If `claude-sonnet-4-5` Doesn't Work:

**Option 1: Use date-based versions**
```typescript
{
  id: "claude-sonnet-4-20250514",  // Explicit API version
  name: "Claude Sonnet 4.5",
  // ...
}
```

**Option 2: Check if alias exists**
- Anthropic may support `claude-4-sonnet-latest`
- Or `claude-sonnet-4` → auto-resolves to latest

---

## Summary

### Current Behavior

✅ **UI Model ID:** `claude-sonnet-4-5`  
✅ **API Receives:** `claude-sonnet-4-5` (direct, no mapping)  
❓ **Is This Valid?** Need to verify with Anthropic API

### Key Difference from OpenAI

- **Anthropic:** No model ID transformation (direct pass-through)
- **OpenAI:** Transforms `gpt-5-2-low` → `gpt-5-2` + reasoning effort

### Next Steps

1. **Test API call** with `claude-sonnet-4-5` to confirm it works
2. **Check Anthropic docs** for correct model identifier format
3. **Update if needed** to use date-based versions or correct aliases

---

## Related Files

- `ui/constants/models.ts` - Model definitions
- `ui/components/Chat/ChatContainer.tsx` - Model selection
- `src/gateway/services/ChatSessionManager.ts` - Model initialization
- `src/core/agents/MastraAgent.ts` - Mastra SDK integration
