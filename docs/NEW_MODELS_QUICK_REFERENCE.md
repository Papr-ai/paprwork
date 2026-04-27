# New Model IDs - Quick Reference

**Added:** 2026-04-24  
**Updated:** 2026-04-24 (GPT-5.4 replaced with GPT-5.5)

## GPT-5.5 (OpenAI) - Replaces GPT-5.4

### For AI SDK and API
```typescript
// Low reasoning (faster)
model: "gpt-5.5-low"

// Medium reasoning (default, recommended)
model: "gpt-5.5"

// High reasoning (deeper)
model: "gpt-5.5-high"

// Pro (highest accuracy, 6x cost)
model: "gpt-5.5-pro"

// Mini (budget option, 272K context)
model: "gpt-5.4-mini"
```

### For pi-ai OAuth (ChatGPT Plus/Pro)
```typescript
// Same IDs - automatically detected
provider: "openai-codex"
model: "gpt-5.5" // or "gpt-5.5-pro"
```

### Pricing
- **gpt-5.5-low/med/high**: $5 / $30 per 1M tokens (2x more than GPT-5.4)
- **gpt-5.5-pro**: $30 / $180 per 1M tokens (6x more than GPT-5.5)
- **gpt-5.4-mini**: $0.75 / $4.50 per 1M tokens (unchanged)

### Context
- **GPT-5.5**: 1M tokens (1,000,000) - 750K threshold in Paprwork (250K buffer)
- **GPT-5.4-mini**: 272K tokens - 200K threshold in Paprwork (72K buffer)

---

## Claude Opus 4.7 (Anthropic)

### For AI SDK and API
```typescript
model: "claude-opus-4-7"
```

### For pi-ai OAuth (Claude Pro/Max)
```typescript
// Same ID - automatically detected
provider: "anthropic"
model: "claude-opus-4-7"
```

### Pricing
- **$5 / $25 per 1M tokens** (67% cheaper than Opus 4.6!)
- **Cheaper than GPT-5.5** despite similar 1M context

### Context
- 1M tokens (implicit)
- 750K threshold in Paprwork (250K buffer)

---

## Price Comparison

| Model | Input | Output | vs Previous |
|-------|-------|--------|-------------|
| **GPT-5.5** | $5 | $30 | 2x more than GPT-5.4 |
| GPT-5.4 (legacy) | $2.50 | $15 | Replaced by 5.5 |
| GPT-5.4-mini | $0.75 | $4.50 | Unchanged |
| **Claude Opus 4.7** | $5 | $25 | 67% cheaper than 4.6 |
| Claude Opus 4.6 (legacy) | $15 | $75 | 3x more expensive |
| Claude Sonnet 4.6 | $3 | $15 | Most economical mid-tier |

**Winner:** Claude Opus 4.7 = Same input as GPT-5.5, cheaper output, similar 1M context! 🏆

---

## Usage in Paprwork

### New Model Picker Options

**OpenAI:**
- GPT-5.4 mini (budget)
- GPT-5.5 (Low Reasoning)
- GPT-5.5 (recommended) ⭐
- GPT-5.5 (High Reasoning)
- GPT-5.5 Pro (highest accuracy)
- GPT-5.3 Codex (OAuth only)

**Anthropic:**
- Claude Haiku 4.5 (budget)
- Claude Sonnet 4.6 (mid-tier)
- Claude Opus 4.6 (legacy)
- Claude Opus 4.7 (latest) ⭐

Both support:
- ✅ Standard API keys
- ✅ OAuth (ChatGPT Plus/Pro or Claude Pro/Max)
- ✅ Tool calling
- ✅ Streaming
- ✅ Cost tracking

---

## When to Use

### GPT-5.5
- Complex agentic workflows
- Long-running tasks (750K context buffer)
- Terminal/command-line tasks (best benchmark score)
- Multi-step reasoning
- **Reason to upgrade from 5.4:** 3.75x more context (1M vs 272K)

### GPT-5.5 Pro
- Hardest problems requiring highest accuracy
- When you need absolute best performance
- Critical tasks where extra cost is justified
- Scientific/technical research

### GPT-5.4-mini
- Budget-conscious users
- Simple tasks
- High-volume API usage
- Sub-agents and delegation
- **Price advantage:** 6.7x cheaper than GPT-5.5

### Claude Opus 4.7
- Agentic coding (best SWE-Bench score)
- Code review and refactoring
- Long-form content generation
- Complex multimodal tasks (high-res image support)
- **Best value:** Same input price as GPT-5.5, cheaper output

