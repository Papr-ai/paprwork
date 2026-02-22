# OAuth Model Equivalents

**Question:** Which models in our message input picker have OAuth equivalents (can use ChatGPT/Claude subscription instead of API key)?

---

## Summary

| Our model (message input) | Provider | OAuth equivalent? | Current behavior |
|---------------------------|----------|-------------------|------------------|
| **gpt-5-mini** | openai | ❌ No | API key only – openai-codex doesn't have gpt-5-mini |
| **gpt-5.2-low** | openai | ⚠️ Yes (gpt-5.2) | Uses API key path – could use OAuth |
| **gpt-5.2** | openai | ✅ Yes | Uses API key path – could use OAuth |
| **gpt-5.2-high** | openai | ⚠️ Yes (gpt-5.2) | Uses API key path – could use OAuth |
| **gpt-5.2-xhigh** | openai | ⚠️ Yes (gpt-5.2) | Uses API key path – could use OAuth |
| **gpt-5.2-codex** | openai | ✅ Yes | Uses API key path – could use OAuth |
| **gpt-5.3-codex** | openai-codex | ✅ Yes | Already uses OAuth path |
| **claude-haiku-4-5** | anthropic | ✅ Yes | Already OAuth-capable (pi-ai) |
| **claude-sonnet-4-6** | anthropic | ✅ Yes | Already OAuth-capable (pi-ai) |
| **claude-opus-4-6** | anthropic | ✅ Yes | Already OAuth-capable (pi-ai) |
| **claude-opus-4-5-thinking** | anthropic | ✅ Yes | Already OAuth-capable (pi-ai) |
| **gemini-*** | google | ❌ No | No Google OAuth in our stack |

---

## pi-ai openai-codex (ChatGPT OAuth) – supported models

From `@mariozechner/pi-ai` models.generated.js, the **openai-codex** provider supports:

| pi-ai model | In our picker? | Notes |
|-------------|----------------|-------|
| gpt-5.1 | No | Could add |
| gpt-5.1-codex-mini | No | Could add |
| gpt-5.1-codex-max | No | Could add |
| **gpt-5.2** | Yes (as gpt-5.2, gpt-5.2-low, gpt-5.2-high, gpt-5.2-xhigh) | Same base model, reasoning effort in options |
| **gpt-5.2-codex** | Yes | Direct match |
| **gpt-5.3-codex** | Yes | Already on openai-codex |
| gpt-5.3-codex-spark | No | Ultra-fast Codex variant |

---

## Current routing

- **provider: "openai"** → AI SDK path (API key only)
- **provider: "openai-codex"** → pi-ai path (OAuth token)
- **provider: "anthropic"** → pi-ai path (OAuth or API key)

So today:

- `gpt-5.2`, `gpt-5.2-codex`, etc. with `provider: "openai"` always use the API key.
- Only `gpt-5.3-codex` with `provider: "openai-codex"` uses OAuth.

---

## Enabling OAuth for more GPT models

To let users use their ChatGPT subscription for `gpt-5.2`, `gpt-5.2-codex`, etc.:

1. Add OAuth-backed variants in `models.ts`, e.g.:
   - `gpt-5.2` with `provider: "openai-codex"` and `requiresApiKey: "OPENAI_OAUTH"`
   - `gpt-5.2-codex` with `provider: "openai-codex"` and `requiresApiKey: "OPENAI_OAUTH"`
2. Or: when OAuth is connected and no API key, route `provider: "openai"` requests to the pi-ai openai-codex path for supported models.

---

## Anthropic

Anthropic models already support both OAuth and API key. `getProviderAuth("anthropic")` prefers OAuth when available, so no routing change is needed.
