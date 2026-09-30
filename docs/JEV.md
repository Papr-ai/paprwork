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

**Memory server:** Implemented in the `memory` repo at `routers/v1/typesafe_routes.py` (`POST /v1/typesafe/systemone`). Auth and upstream TypeSafe share a **pooled** `httpx.AsyncClient` (`routers/v1/ai_proxy_http_clients.py`) — same pattern as `/v1/ai/{openai,anthropic,google,...}` non-streaming and streaming proxies. E2E: `memory/tests/test_ai_proxy_upstream_e2e.py`.

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

## Latency benchmark

Measure where time goes (client wall clock + server `X-Papr-Proxy-Timing` when memory is deployed):

```bash
export BENCH_PAPR_API_KEY='sk-org-...'   # Papr login key
export BENCH_PAPR_USER_ID='...'          # optional for --include-turn2
npm run benchmark:jev-latency
npm run benchmark:jev-latency -- --include-turn2 --iterations=5
npm run benchmark:jev-latency -- --include-llm   # one mini OpenAI proxy call (uses credits)
```

Phases: memory health RTT, minimal `jev_decide`, one catalog batch (12 scores), optional turn-2 (sync tiers, message search, Jev catalog gate), optional LLM proxy.

Memory server splits proxy time into **auth**, **limits**, **upstream** via `routers/v1/proxy_request_timing.py`.

## Follow-ups

- UI catalog + `jev_pick_ui` for mini-app pattern selection
- Overnight question packs wired into Sleep / Wiki / Home Brief jobs
- Org-level TypeSafe billing entirely via Papr proxy (no BYOK)
