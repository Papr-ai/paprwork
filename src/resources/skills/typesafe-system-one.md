---
id: preloaded-typesafe-system-one
name: TypeSafe System One (Jev)
description: Official-style guardrails for jev_decide — auth, limits, confidence, and when to use typed decisions vs chat models.
---
# TypeSafe System One (Jev)

Paprwork calls Jev through **`jev_decide`**. This skill complements **`preloaded-jev-decisions`** (workflows). Load both when building triage, sleep/wiki gates, or overnight classifiers.

## Not required

- Vercel AI SDK
- `experimental_evaluate` / AI Gateway routes
- Claude Code `npx skills` (Paprwork ships preloaded skills instead)

Implementation is **HTTP POST** to System One (`state` + typed `questions` → `answers` with probabilities).

## Authentication (pick one)

| Method | When | Key |
|--------|------|-----|
| **Papr proxy** (preferred when logged in) | User signed in with Papr | `PAPR_API_KEY` → `POST {memory server}/v1/typesafe/systemone` with `X-API-Key` |
| **TypeSafe BYOK** | User has console.typesafe.ai key | `TYPESAFE_API_KEY` → `POST https://api.typesafe.ai/v1/systemone` with `Bearer` |

If Papr proxy returns 404/503 and BYOK is set, Paprwork retries direct TypeSafe once.

## Guardrails (enforced in code)

| Limit | Value |
|-------|-------|
| `state` size | 32,000 chars (string or JSON) |
| Questions per call | 20 |
| Choice options | 255 max |
| Score rubric levels | 32 max |

**Do:** one compact state blob + a small question pack reused across jobs.  
**Don't:** paste transcripts, invent new schemas per job, or use Jev to write prose.

## Confidence policy (agent behavior)

| Signal | Action |
|--------|--------|
| noul / top choice ≥ **0.85** | Safe to auto-route or auto-act *if* action is reversible |
| **0.60 – 0.84** | Ask one clarifying question or show options |
| **< 0.60** | Escalate to user; do not automate |

Probabilities are **not** guarantees — branch in code, don't narrate "Jev said so."

## Question types

- **noul** — yes/no (accept `boolean` alias)
- **choice** — pick one labeled option (≥2 criteria)
- **score** — ordered rubric levels (≥2 levels)

## Further reading

- [TypeSafe docs](https://docs.typesafe.ai/)
- [LLM-oriented index](https://docs.typesafe.ai/llms.txt)
- Paprwork: `docs/JEV.md`
