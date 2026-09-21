# TypeSafe Jev (`jev_decide`)

[Jev](https://docs.typesafe.ai/) is a **System One** model: you send compact **state** plus typed **questions** (noul, choice, score) and get structured answers with probabilities. It does **not** generate chat text.

Paprwork exposes Jev as the **`jev_decide`** Mastra tool. Jev is **not** a chat provider and must not be selected as `provider` / `model` for agent jobs.

## Setup

1. Get an API key from [console.typesafe.ai](https://console.typesafe.ai).
2. Add **Settings → Custom API Keys**:
   - Name: `TYPESAFE_API_KEY` (upper snake)
   - Permission: **always** if jobs should run unattended
3. Or set `TYPESAFE_API_KEY` in `.env.local` when running from source.

## When to use what

| Need | Mechanism |
|------|-----------|
| One decision in the current chat | `jev_decide` tool |
| Same decision on a schedule / folder watch | Node/Python **job** calling `evaluateJev` or `${TYPESAFE_API_KEY}` |
| Standing policy + memory | **Sub-agent** whose allowed tools include `jev_decide` |

Load the skill: `read_skill({ skillId: "preloaded-jev-decisions" })`.

## Implementation

- `src/core/tools/jevClient.ts` — HTTP client, key resolution, validation
- `src/core/tools/jevDecide.ts` — `jev_decide` tool
- `tests/jev-decide-tool.test.ts` — unit tests (mocked fetch)

Jobs can import `evaluateJev` from `@core` re-exports in `src/core/tools/index.ts` for shared schema and timeouts.

## Follow-ups (not in v1)

- Preloaded overnight question packs (Sleep / Wiki / Home Brief jobs)
- UI catalog + `jev_pick_ui` for mini-app pattern selection
- Optional Vercel AI Gateway route to `typesafe-ai/jev`
