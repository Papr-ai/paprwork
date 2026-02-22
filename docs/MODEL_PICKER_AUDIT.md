# Model Picker Audit: models.ts vs AI SDK vs pi-ai vs OAuth

**Date:** 2026-02-17  
**Purpose:** Fix model picker in message input UI; align model IDs across frontend, AI SDK, pi-ai, and OAuth.

---

## Summary

| Source | Format | Examples |
|--------|--------|----------|
| **OpenAI API** | Dots | `gpt-5.2`, `gpt-5.2-codex` |
| **AI SDK @ai-sdk/openai** | Dots | `gpt-5.2`, `gpt-5.2-pro`, `gpt-5.1-codex` |
| **AI SDK @ai-sdk/google** | Dots | `gemini-2.5-flash`, `gemini-3-pro-preview` |
| **pi-ai (anthropic)** | Dashes | `claude-sonnet-4-6`, `claude-opus-4-6` |
| **pi-ai (openai-codex)** | Dots | `gpt-5.1-codex`, `gpt-5.2-codex` (via openai-codex provider) |
| **models.ts (current)** | Mixed | `gpt-5.2` (dots), `claude-sonnet-4-6` (dashes), `gemini-2.5-flash` (dots) |

**Critical bug:** ChatSessionManager and AgentService expect `gpt-5-2-*` (dashes) but models.ts sends `gpt-5.2-*` (dots). The `startsWith("gpt-5-2-")` check fails, so reasoning variants are not normalized.

---

## Model-by-Model Mapping

### OpenAI (API key path – AI SDK)

| models.ts id | AI SDK model | Reasoning effort | OAuth |
|--------------|--------------|-----------------|-------|
| `gpt-5-mini` | `gpt-5-mini` | N/A | No |
| `gpt-5.2-low` | `gpt-5.2` | `low` | No |
| `gpt-5.2` | `gpt-5.2` | `medium` | No |
| `gpt-5.2-high` | `gpt-5.2` | `high` | No |
| `gpt-5.2-xhigh` | `gpt-5.2` | `xhigh`* | No |
| `gpt-5.2-codex` | `gpt-5.2-codex`** | `medium` | No |

\* `xhigh` only supported on GPT-5.1-Codex-Max; may error on gpt-5.2.  
\** AI SDK list has `gpt-5.1-codex` but not `gpt-5.2-codex`; SDK accepts `(string & {})` so it may work.

### OpenAI Codex (OAuth path – pi-ai)

| models.ts id | pi-ai provider | pi-ai model | OAuth |
|--------------|---------------|-------------|-------|
| `gpt-5.3-codex` | `openai-codex` | `gpt-5.3-codex` | Yes (ChatGPT Plus/Pro) |

### Anthropic (API key or OAuth – pi-ai)

| models.ts id | pi-ai model | OAuth |
|--------------|-------------|-------|
| `claude-haiku-4-5` | `claude-haiku-4-5`* | Optional |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | Optional |
| `claude-opus-4-6` | `claude-opus-4-6` | Optional |
| `claude-opus-4-5-thinking` | `claude-opus-4-5-thinking`* | Optional |

\* Verify pi-ai has these exact IDs; pi-ai uses `anthropic.claude-*-*` in some cases.

### Google (AI SDK)

| models.ts id | AI SDK model | OAuth |
|--------------|--------------|-------|
| `gemini-2.5-flash-lite` | `gemini-2.5-flash-lite` | No |
| `gemini-2.5-flash` | `gemini-2.5-flash` | No |
| `gemini-3-flash-preview` | `gemini-3-flash-preview` | No |
| `gemini-3-pro-preview` | `gemini-3-pro-preview` | No |

---

## Fixes Applied

### 1. ChatSessionManager – Accept both dots and dashes

- Accept `gpt-5.2-*` and `gpt-5-2-*`.
- Normalize to `gpt-5.2` for API (or `gpt-5.2-codex` for codex).
- Pass `reasoning.effort` in provider options when creating the model.

### 2. AgentService createLanguageModel – Same normalization

- Accept both formats.
- Map to API model ID (dots).

### 3. models.ts – Keep dots for OpenAI/Google

- OpenAI: `gpt-5.2`, `gpt-5.2-low`, etc. (matches API).
- Google: `gemini-2.5-flash` (matches API).
- Anthropic: `claude-sonnet-4-6` (dashes, matches pi-ai).

### 4. OAuth-aware filtering (future)

- Filter or label models by auth: show OAuth models when OAuth is connected.
- `gpt-5.3-codex` → requires `OPENAI_OAUTH` or ChatGPT OAuth.
- Claude models → optional OAuth or `ANTHROPIC_API_KEY`.

---

## Reasoning Effort Mapping

| UI model | API model | reasoning.effort |
|----------|-----------|------------------|
| `gpt-5.2-low` | `gpt-5.2` | `low` |
| `gpt-5.2` | `gpt-5.2` | `medium` |
| `gpt-5.2-high` | `gpt-5.2` | `high` |
| `gpt-5.2-xhigh` | `gpt-5.2` | `xhigh` |
| `gpt-5.2-codex` | `gpt-5.2-codex` | `medium` |

---

## AgentsView vs Chat InputBar

- **AgentsView** uses a hardcoded `modelOptions` array (dashes: `gpt-5-2`, etc.).
- **InputBar** uses `CHAT_MODELS` from `models.ts` (dots for OpenAI).
- Recommendation: Use `CHAT_MODELS` / `getModelById` in AgentsView instead of a separate list to avoid drift.
