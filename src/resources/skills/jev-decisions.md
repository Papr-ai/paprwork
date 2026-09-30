---
id: preloaded-jev-decisions
name: Jev Typed Decisions
description: Use jev_decide for classification, routing, and scoring. Jev is not a chat model. Jobs and sub-agents should reuse this tool instead of inventing curl payloads.
---
# Jev Typed Decisions

Jev (TypeSafe System One) answers typed questions about a state. It does **not** generate text.

## When to use `jev_decide`

- Route a ticket, email, or message to a queue
- Score urgency, risk, quality, or frustration
- Yes/no gates before bash, browser, or send actions
- Pick the next constrained option from a list you already know

## When not to use it

- Writing replies, code, summaries, or plans
- Counting, date math, or anything code can compute
- Dumping the entire conversation into `state`

## Auth

**Either:**

1. **Papr login** — uses memory-server proxy (`PAPR_API_KEY`), no TypeSafe account required when proxy is enabled on Papr cloud.
2. **`TYPESAFE_API_KEY`** — direct BYOK from [console.typesafe.ai](https://console.typesafe.ai).

Also read **`preloaded-typesafe-system-one`** for limits and confidence policy.

If neither is configured:

```javascript
request_key({
  name: "TYPESAFE_API_KEY",
  description: "TypeSafe Jev API key for typed decisions",
  sourceUrl: "https://console.typesafe.ai",
  permission: "always"
})
```

## Guardrails

- Summarize into `state` (max ~32k chars) — never the full chat
- Max 20 questions per call; reuse question packs in jobs
- Do not use Jev for generation (email, code, summaries)

## Live chat

Call the tool. Do not create a job for a single judgment.

```javascript
jev_decide({
  state: "I was charged twice and need a refund today",
  questions: {
    queue: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Payments, invoices, refunds",
        technical: "Bugs, outages, integrations",
        sales: "Pricing and upgrades"
      }
    },
    urgent: {
      type: "noul",
      instructions: "Does the message express time-sensitivity?"
    }
  }
})
```

Then branch in this chat. High confidence → act. Low confidence → ask the user.

## Recurring classification

Create a node or python job that reads items and calls the same TypeSafe endpoint (or, in an agent job, calls `jev_decide`). Reuse question packs. Do not let each job invent a new schema.

## Sub-agent for triage

```javascript
create_sub_agent({
  name: "triage",
  systemPrompt: "You only classify. Always call jev_decide. Never write the user-facing reply.",
  allowedToolIds: ["jev_decide", "read_file", "write_file"]
})
```

Jev cannot be the sub-agent provider / model.

## Overnight (Sleep / Wiki / Home Brief)

Use Jev in **jobs**, not as the brief writer:

1. **Sleep** — classify each captured item (lane, goal_linked, needs_morning) before writing SLEEP.md
2. **Wiki** — gate `write_now` / `entity_type` before editing entity pages
3. **Home brief** — rank candidates (slot, goal_id) before the agent job writes prose; optional rubric check after

The generative model still writes the brief and wiki prose. Jev only filters and scores.
