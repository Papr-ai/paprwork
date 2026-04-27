# GPT-5.5 and Claude Opus 4.7 Model Addition

**Added:** 2026-04-24

## Summary

Added support for the latest flagship models from OpenAI and Anthropic:
- **GPT-5.5** (released April 23, 2026) - Latest OpenAI flagship with 1M context
- **GPT-5.5 Pro** - Highest accuracy variant (6x cost)
- **Claude Opus 4.7** (released April 16, 2026) - Latest Anthropic flagship with 1M context

## Model Details

### GPT-5.5 (OpenAI)

**Model IDs:**
- `gpt-5.5` (medium reasoning effort, default)
- `gpt-5.5-pro` (higher accuracy, 6x cost)

**Key Features:**
- 1M token context window (vs 272K in GPT-5.4)
- 128K max output tokens
- Reasoning effort: medium (default), also supports low, high, xhigh
- First fully retrained base model since GPT-4.5
- Built specifically for agentic workflows

**Pricing:**
- **GPT-5.5**: $5 per 1M input / $30 per 1M output
- **GPT-5.5 Pro**: $30 per 1M input / $180 per 1M output

**Benchmarks:**
- Terminal-Bench 2.0: 82.7% (13 points ahead of Opus 4.7)
- GDPval (knowledge work): 84.9%
- OSWorld-Verified (computer use): 78.7%
- Artificial Analysis Intelligence Index: 60 (3 points ahead of Opus 4.7)

### Claude Opus 4.7 (Anthropic)

**Model ID:**
- `claude-opus-4-7`

**Key Features:**
- 128K max output tokens
- 1M context window (implicit from docs)
- Improved multimodal support (up to 2,576px on long edge, ~3.75MP)
- Step-change improvement in agentic coding over Opus 4.6

**Pricing:**
- $5 per 1M input / $25 per 1M output

**Benchmarks:**
- SWE-Bench Pro: 64.3% (best among all models)
- Best for agentic coding and complex reasoning

## Changes Made

### 1. Model Configuration (`ui/constants/models.ts`)

Added both models to `CHAT_MODELS` array:
- GPT-5.5 with 128K max tokens, medium reasoning effort
- GPT-5.5 Pro with 128K max tokens, high reasoning effort
- Claude Opus 4.7 with 128K max tokens, extended thinking support

Updated default model preferences:
- `MID_TIER_MODEL_IDS` - Added GPT-5.5 and Claude Opus 4.7 as top choices
- `DEFAULT_MODEL_IDS` - Added both as preferred defaults

### 2. Cost Calculation (`src/gateway/services/CostCalculation.ts`)

Added pricing entries:
- `gpt-5.5`: $5 / $30 per 1M tokens
- `gpt-5.5-pro`: $30 / $180 per 1M tokens
- `claude-opus-4-7`: $5 / $25 per 1M tokens

Updated pricing date to 2026-04-24

### 3. Model Normalization (`src/gateway/utils/modelNormalizer.ts`)

Enhanced `normalizeOpenAIModelId()`:
- Added dash-to-dot conversion for `gpt-5-5` → `gpt-5.5`
- Added handling for `gpt-5.5-pro` as distinct model
- Added reasoning suffix stripping for `gpt-5.5-<effort>` → `gpt-5.5`

Enhanced `isOpenAICodexModel()`:
- Added `gpt-5.5` and `gpt-5.5-pro` to OAuth support list
- Added check for GPT-5.5 with reasoning suffixes

### 4. Agent Service (`src/gateway/services/AgentService.ts`)

Enhanced manual model registry creation for pi-ai OAuth:
- Added cost detection for GPT-5.5 ($5/$30) and GPT-5.5 Pro ($30/$180)
- Added display names for both variants

Updated context abort threshold:
- GPT-5.5: 750K threshold (1M context - 250K buffer)
- GPT-5.4: 200K threshold (272K context - 72K buffer) - unchanged
- Claude Opus 4.7: 750K threshold (1M context - 250K buffer)
- Older Claude: 120K threshold (200K context - 80K buffer) - unchanged

### 5. Pi-AI Stream Handler (`src/gateway/services/providers/PiCodexStreamWithToolLoop.ts`)

Updated context threshold logic:
- GPT-5.5: 750K threshold (allows 3.75x more context than GPT-5.4)
- Claude Opus 4.7: 750K threshold (matches GPT-5.5)
- Maintains existing thresholds for other models

## OAuth Support

Both models support OAuth authentication via ChatGPT Plus/Pro and Claude Pro/Max subscriptions:

**GPT-5.5 OAuth:**
- Available through `openai-codex` provider (pi-ai)
- Model IDs: `gpt-5.5`, `gpt-5.5-pro`
- Routing: Auto-detects OAuth tokens and uses ChatGPT backend

**Claude Opus 4.7 OAuth:**
- Available through `anthropic` provider (pi-ai)
- Model ID: `claude-opus-4-7`
- Routing: Auto-detects OAuth tokens and uses Claude backend

## API Support

Both models also work with standard API keys:

**GPT-5.5 API:**
- Provider: `openai`
- AI SDK: Uses `@ai-sdk/openai` package
- Model IDs: `gpt-5.5`, `gpt-5.5-pro`

**Claude Opus 4.7 API:**
- Provider: `anthropic`
- AI SDK: Uses `@ai-sdk/anthropic` package
- Model ID: `claude-opus-4-7`

## Context Window Improvements

The 1M context windows in GPT-5.5 and Claude Opus 4.7 provide significant improvements:

**Before (GPT-5.4, Claude Opus 4.6):**
- 272K context (GPT-5.4) or 200K context (Claude Opus 4.6)
- Hit limits after 20-30 tool calls in long conversations
- Required compression/summarization more frequently

**After (GPT-5.5, Claude Opus 4.7):**
- 1M context (3.7x more for GPT, 5x more for Claude)
- Can handle 75-100+ tool calls before compression needed
- Better for long-running agentic workflows
- More context for code review, debugging, research

## Testing

Test both models through:
1. Model picker UI (both should appear in OpenAI and Anthropic groups)
2. OAuth flow (ChatGPT Plus/Pro or Claude Pro/Max)
3. API key flow (standard OpenAI/Anthropic API keys)
4. Long conversations with 50+ tool calls (verify context threshold works)
5. Cost calculation (verify pricing displays correctly)

## References

- [OpenAI GPT-5.5 Announcement](https://openai.com/index/introducing-gpt-5-5/)
- [OpenAI GPT-5.5 API Docs](https://developers.openai.com/api/docs/models/gpt-5.5)
- [Anthropic Claude Opus 4.7 Announcement](https://www.anthropic.com/news/claude-opus-4-7)
- [Claude Opus 4.7 API Docs](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)

## Related Issues/Enhancements

- Enhancement 17: GPT-5.4 Context Limit Fix (context-aware thresholds)
- Enhancement 10: OAuth Context Management (pi-ai routing)
- CLAUDE.md: OAuth & pi-ai Architecture documentation
