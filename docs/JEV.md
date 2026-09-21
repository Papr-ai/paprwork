# TypeSafe Jev (`jev_decide`)

[Jev](https://docs.typesafe.ai/) is a **System One** model: you send compact **state** plus typed **questions** (noul, choice, score) and get structured answers with probabilities. It does **not** generate chat text.

Paprwork exposes Jev as the **`jev_decide`** Mastra tool. Jev is **not** a chat provider and must not be selected as `provider` / `model` for agent jobs.

## Vercel / AI SDK

**Not required.** Paprwork uses plain `fetch` to the System One HTTP API. You do **not** need Vercel AI Gateway, `experimental_evaluate`, or `@typesafe-ai/sdk` in the desktop app (SDK optional for jobs later).

## Authentication

| Priority | Credential | Endpoint | Header |
|----------|------------|----------|--------|
| 1 | Papr login → `PAPR_API_KEY` | `{PAPR_MEMORY_SERVER_URL}/v1/typesafe/systemone` | `X-API-Key` |
| 2 | `TYPESAFE_API_KEY` (Settings / env) | `https://api.typesafe.ai/v1/systemone` (override: `TYPESAFE_SYSTEMONE_URL`) | `Bearer` |

If the Papr proxy is not deployed (404/503) and BYOK is configured, the client retries direct TypeSafe once.

**Memory server note:** Papr cloud must expose `POST /v1/typesafe/systemone` (forward to TypeSafe with org billing). Until then, use BYOK or deploy the route on `memory.papr.ai`.

Env overrides:

- `JEV_PROXY_PATH` — default `/v1/typesafe/systemone`
- `PAPR_MEMORY_SERVER_URL` — default `https://memory.papr.ai`

## Skills (in-app)

Agents should load:

1. `read_skill({ skillId: "preloaded-jev-decisions" })` — workflows
2. `read_skill({ skillId: "preloaded-typesafe-system-one" })` — guardrails + auth

No Claude Code `npx skills` required for end users.

## Guardrails (enforced)

See `src/core/tools/jevGuardrails.ts`:

- State max 32k chars
- Max 20 questions per call
- Choice/score option limits

## When to use what

| Need | Mechanism |
|------|-----------|
| One decision in the current chat | `jev_decide` tool |
| Same decision on a schedule / folder watch | Node/Python **job** via `evaluateJevWithAuth` / shared HTTP |
| Standing policy + memory | **Sub-agent** with `jev_decide` in `allowedToolIds` |

## Implementation

- `src/core/tools/jevClient.ts` — HTTP + validation
- `src/core/tools/jevAuth.ts` — Papr proxy vs BYOK
- `src/core/tools/jevGuardrails.ts` — limits
- `src/core/tools/jevDecide.ts` — Mastra tool
- `tests/jev-decide-tool.test.ts` — unit tests

## Follow-ups

- UI catalog + `jev_pick_ui` for mini-app pattern selection
- Overnight question packs wired into Sleep / Wiki / Home Brief jobs
- Org-level TypeSafe billing entirely via Papr proxy (no BYOK)
