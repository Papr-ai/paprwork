# GPT-5.4 Integration Guide

**Added:** 2026-03-05  
**Status:** ✅ Complete

## Overview

GPT-5.4 is OpenAI's latest model release with native computer use capabilities, improved efficiency, and enhanced performance on complex multi-step workflows. Paprwork V2 now supports both GPT-5.4 variants via AI SDK (API key) and pi-ai (OAuth).

## Model Variants

### GPT-5.4 Thinking (`gpt-5.4`)
- **Target Users:** ChatGPT Plus ($20/mo), ChatGPT Enterprise, and API users
- **Capabilities:** 
  - Native computer use mode (screenshot + keyboard/mouse control)
  - 47% fewer tokens on some tasks vs predecessors
  - 1M token context window (API/Codex)
  - Tool search for efficient large tool set handling
  - Enhanced factual accuracy (33% fewer false claims)
- **Pricing (API):** 
  - $2.50 / 1M input tokens
  - $15.00 / 1M output tokens
  - 2× rate for inputs exceeding 272K tokens
- **Max Output:** 128,000 tokens

### GPT-5.4 Pro (`gpt-5.4-pro`)
- **Target Users:** ChatGPT Pro ($200/mo), Enterprise, and API users
- **Capabilities:** Same as GPT-5.4 Thinking but optimized for most complex tasks
- **Pricing (API):**
  - $30.00 / 1M input tokens
  - $180.00 / 1M output tokens
  - 2× rate for inputs exceeding 272K tokens
- **Max Output:** 128,000 tokens

## Key Features

### 1. Native Computer Use
- First OpenAI model with built-in computer control
- Can write Playwright code for browser automation
- Can issue mouse/keyboard commands from screenshots
- BrowseComp: 89.3% (GPT-5.4 Pro) vs 72% (GPT-5.2)
- OSWorld-Verified: 75.0% vs 47.3% (GPT-5.2)

### 2. Tool Search Optimization
- Retrieves tool definitions on-demand instead of loading all upfront
- 47% token reduction on Scale's MCP Atlas (36 MCP servers, 250 tasks)
- Reduces context pollution for large tool sets

### 3. Enhanced Accuracy
- 33% fewer false claims vs GPT-5.2
- 18% fewer responses containing any errors
- Improved factual grounding

### 4. Professional Outputs
- Better spreadsheet modeling (87.5% vs 68.4% for GPT-5.2)
- Improved presentation quality (68% preference over GPT-5.2)
- Enhanced financial reasoning (88.0% vs 43.7% on investment banking benchmark)

## Integration Details

### Supported Routes

| Auth Method | Provider | Route | Status |
|-------------|----------|-------|--------|
| API Key | `openai` | AI SDK (Platform API) | ✅ Available |
| OAuth (ChatGPT Plus/Pro) | `openai-codex` | pi-ai (`openai-codex`) | ✅ Available (manual model creation) |

**Note:** GPT-5.4 models work with OAuth via manual model object creation. Even though pi-ai's registry doesn't have GPT-5.4 yet, we create the model objects programmatically since ChatGPT's backend supports any model ID.

### Files Modified

1. **UI Model Definitions** (`ui/constants/models.ts`)
   - Added `gpt-5.4` and `gpt-5.4-pro` model definitions
   - Updated default model preferences to prioritize GPT-5.4
   - Set `maxTokens: 128000` (matching API limit)

2. **Cost Calculation** (`src/gateway/services/CostCalculation.ts`)
   - Added pricing for both variants
   - GPT-5.4: $2.50/$15.00 per 1M tokens
   - GPT-5.4 Pro: $30.00/$180.00 per 1M tokens

3. **Model Normalizer** (`src/gateway/utils/modelNormalizer.ts`)
   - Added GPT-5.4 and GPT-5.4 Pro to `OPENAI_CODEX_MODELS` set
   - Ensures proper routing for OAuth path
   - Handles normalization for API calls

4. **Delegation Tool** (`src/core/tools/delegation.ts`)
   - Added `gpt-5.4` and `gpt-5.4-pro` to `SUBAGENT_MODEL_IDS`
   - Allows sub-agents to use new models

### Automatic Handling

These components already support GPT-5.4 without changes:

- **ChatSessionManager** - Any model starting with `gpt-5` uses Responses API
- **AgentService** - OAuth routing works based on provider and auth type
- **Context Management** - Adaptive truncation works for all models
- **Streaming** - AI SDK handles streaming for both variants

## Usage Examples

### 1. API Key (AI SDK)

```typescript
// User selects "GPT-5.4 Thinking" from model picker
const config = {
  provider: "openai",
  model: "gpt-5.4",
  authType: "apiKey",
  apiKey: process.env.OPENAI_API_KEY,
  reasoning: { effort: "medium" },
};

// Routes to AI SDK (Platform API)
// Automatically uses openai.responses() for streaming
```

### 2. OAuth (pi-ai) - WORKING NOW!

```typescript
// ✅ Fully working via manual model creation
// User connects ChatGPT Plus/Pro account via OAuth
// User selects "GPT-5.4 Thinking" from model picker

// AgentService detects model not in pi-ai registry
// Creates model object manually with correct structure
const config = {
  provider: "openai",
  model: "gpt-5.4",
  authType: "oauth",
  apiKey: oauthToken, // From ChatGPT OAuth
};

// Routes to pi-ai openai-codex provider
// Model created on-the-fly if not in registry
// ChatGPT backend accepts any model ID!
```

### 3. Creating Sub-Agent with GPT-5.4

```typescript
await createSubAgent({
  name: "Research Assistant",
  description: "Specialized research agent",
  systemPrompt: "You are a research specialist...",
  provider: "openai",
  model: "gpt-5.4", // ✅ Now available
  allowedToolIds: ["bash", "read_file", "web_search"],
});
```

## Performance Considerations

### Token Efficiency
- GPT-5.4 uses 47% fewer tokens on tool-heavy tasks (with tool search)
- Consider enabling tool search for agents with 10+ tools
- Monitor context usage - 2× pricing kicks in after 272K tokens

### Cost Comparison

| Model | Input | Output | Total (1K/1K) |
|-------|-------|--------|---------------|
| GPT-5.2 | $1.75 | $14.00 | $15.75 |
| GPT-5.4 | $2.50 | $15.00 | $17.50 |
| GPT-5.4 Pro | $30.00 | $180.00 | $210.00 |

**When to use GPT-5.4:**
- Complex multi-step tasks requiring computer use
- Agentic workflows with long context (up to 1M tokens)
- Tasks requiring high factual accuracy
- Financial analysis, spreadsheet modeling

**When to use GPT-5.2:**
- General-purpose tasks
- Cost-sensitive applications
- Tasks not requiring computer use

**When to use GPT-5.4 Pro:**
- Most complex enterprise workflows
- Long-horizon tasks (hours, not minutes)
- Mission-critical accuracy requirements
- Financial modeling, legal analysis

## Known Limitations

1. **Context Window Pricing**
   - Inputs >272K tokens charged at 2× rate
   - Gateway compaction defaults to 272K to avoid extra charges
   - Users can opt into larger context by increasing compaction limit

2. **pi-ai Registry**
   - GPT-5.4 not yet in pi-ai's model registry (as of 2026-03-05)
   - **Workaround implemented:** Models created manually in AgentService
   - OAuth fully working via manual model object creation
   - Will transition to registry models when pi-ai is updated (no code changes needed)

3. **Tool Search**
   - Not yet exposed as user-configurable option
   - Currently handled automatically by model

## Testing

### Verify API Key Route
```bash
# Set API key
export OPENAI_API_KEY="sk-..."

# Start app, select GPT-5.4 from model picker
npm start

# Check logs - should see AI SDK route
# [AgentService] Using AI SDK (API key authentication)
```

### Verify OAuth Route
```bash
# Connect ChatGPT Plus/Pro account in Settings
# Select GPT-5.4 from model picker

# Check logs - should see pi-ai route
# [AgentService] 🔧 Using pi-ai OpenAI Codex provider
# [AgentService] Routing decision: provider=openai authType=oauth
```

## Troubleshooting

### "Model not found" Error
**Cause:** API key doesn't have access to GPT-5.4  
**Solution:** Ensure you have ChatGPT Plus/Pro (OAuth) or Platform API access

### "context_length_exceeded" Error
**Cause:** Input exceeds 1M tokens  
**Solution:** Context management should handle this automatically. If persists, check compaction settings.

### Higher costs than expected
**Cause:** Inputs exceeding 272K tokens trigger 2× pricing  
**Solution:** Monitor input sizes. Gateway compacts to 272K by default.

## Future Enhancements

- [ ] Expose tool search as configurable option
- [ ] Add computer use mode UI indicators
- [ ] Display token efficiency metrics in UI
- [ ] Add context window pricing warnings

## References

- **Official Announcement:** [OpenAI GPT-5.4 Launch](https://openai.com/index/introducing-gpt-5-4/)
- **VentureBeat Article:** [GPT-5.4 with Native Computer Use](https://venturebeat.com/technology/openai-launches-gpt-5-4-with-native-computer-use-mode-financial-plugins-for)
- **Pricing Page:** [OpenAI API Pricing](https://openai.com/api/pricing/)

---

**Last Updated:** 2026-03-05  
**Contributors:** AI Assistant
