# Every Token Ceiling in the Agent Path

**Written:** 2026-09-11
**Question that prompted it:** a user sets 200K in the model settings popover — does anything
silently use a larger number instead? And of the other ceilings, which *should* stay
independent of that setting?

---

## There is no 340K

Searched for `340_000`, `340000`, `340K`, and every env var matching
`(CONTEXT|TOKEN|TRUNCAT|MAX_CHAR|HISTORY)`. The only "340KB" in the repo is prose in
`SystemPrompt.ts` and two skill docs warning the agent not to `read_file` the ~340KB
skills catalog. Nothing reads 340K as a token limit, and no env var sets one.

The number that behaves the way "340K" was remembered to is **`MID_TURN_MAX_TOKENS = 300_000`**
(`src/gateway/services/agent/midTurnContextTrim.ts:15`) — a hardcoded ceiling on in-flight
history. It was being applied *in preference to* the user's setting on the OAuth route. That
is the real defect behind the memory, and it is fixed below.

---

## The inventory

Two kinds of ceiling, and the distinction is the whole answer:

- **Window-derived** — a consequence of how much room the model has. Must honour the user's cap.
- **Quality-driven** — a judgement about how much history is *useful*, independent of how much
  fits. Must not move when the user widens the window, or the setting becomes a quality
  regression switch.

| Constant | Value | Where | Kind | Honours user cap? | Decision |
|---|---|---|---|---|---|
| `PROVIDER_DEFAULT_CONTEXT` | 32K–1M | `contextBudget.ts:11` | window | n/a (fallback when the model registry has no entry) | keep |
| `MIN_CONTEXT_LIMIT` | 128,000 | `contextBudget.ts:40` | window floor | caps the cap | **keep** — a turn carries ~86K of tool schemas before any conversation, so a lower cap budgets nothing |
| `HISTORY_BUDGET_RATIO` | 0.85 | `contextBudget.ts:61` | window | yes, multiplies it | keep |
| `DEFAULT_OUTPUT_RESERVE` | 16,000 | `contextBudget.ts:64` | window | yes, subtracted from it | keep |
| `GEMINI_HISTORY_TOKEN_CAP` | 150,000 | `contextBudget.ts:70` | **quality** | no, deliberately | **keep independent** — Gemini advertises 1M but degrades on long tool-heavy history. A user asking for 1M on Gemini is asking for worse answers |
| `DEFAULT_SUMMARIZE_HISTORY_TOKEN_THRESHOLD` | 40,000 | `contextBudget.ts:73` | **quality** | no, deliberately | **keep independent** — when a summary becomes *worth writing*, not when history stops fitting |
| `SUMMARIZE_MESSAGE_THRESHOLD` | 40 messages | `AgentService.ts:2913` | quality | no | keep independent |
| `SUMMARIZE_CONTEXT_THRESHOLD` | 60,000 | `AgentService.ts:2915` | quality | no | keep independent |
| `MID_TURN_MAX_TOKENS` | 300,000 | `midTurnContextTrim.ts:15` | **window** | **was: no** | **fixed** — now a fallback only for callers that cannot compute a budget |
| `MIN_PRESERVED_HISTORY_TURNS` | 4 turns | `midTurnContextTrim.ts:18` | quality | no | keep — a trim that erases the whole conversation is not a saving |
| `COMPACTION_PRESSURE_RATIO` | 0.70 | `compactionPressure.ts:36` | window | yes, fraction of the budget | new |
| `ABSOLUTE_TOOL_RESULT_MAX_CHARS` | 40,000 chars | `toolResultTruncation.ts:19` | per-payload | no — chars, not window | keep |
| `HISTORY_TOOL_RESULT_MAX_CHARS` | 400 chars | `toolResultTruncation.ts:22` | per-payload | no | keep |
| `HISTORY_TOOL_RESULT_MODERATE_CHARS` | 2,000 chars | `toolResultTruncation.ts:30` | per-payload | no | keep |
| `HEAD_TAIL_TRUNCATION_MAX_CHARS` | 2,000 chars | `toolResultTruncation.ts:25` | per-payload | no | keep |
| `ACTIVE_FILE_READ_MAX_CHARS` | 15,000 chars | `toolResultTruncation.ts:49` | per-payload | no | keep |
| `MID_TURN_INLINE_FLOOR_CHARS` | 4,000 chars | `compactionPressure.ts:52` | per-payload | no | new |

The per-payload limits are all measured in **characters** and all user-configurable through
`toolResultTruncation` settings. They answer "how much of one result is worth carrying", which
is not a question about window size — a 1M window does not make a 500KB `ls` dump worth keeping.
They are correctly independent of the context cap.

---

## What was broken

`config.contextLimit` reached exactly one place: `computeHistoryTokenBudget` on the AI SDK
route (`AgentService.ts:1347`). The OAuth route built its trim bounds without it
(`AgentService.ts:1916`) and `piStreamMemoryWrapUp.ts` hardcoded `maxTokens: MID_TURN_MAX_TOKENS`
at both call sites. So on ChatGPT or Claude OAuth:

- A 200K cap did nothing. In-flight history kept filling to 300K.
- On a 200K-window model the ceiling sat **above the model's own window**, so
  `trimOldestHistoryTurns` could not fire before the provider rejected the request. The trim
  was unreachable code on exactly the models most people run.

Fixed by widening the pi-ai parameter from `HistoryTrimBounds` to `MidTurnTrimOpts` — a type
that already carries `maxTokens` — and passing the same model-aware budget the AI SDK route
computes. `MID_TURN_MAX_TOKENS` survives only as the fallback its name implies.

---

## The resulting ladder

One turn's context, as a fraction of the history budget (itself `min(model window, user cap)`
× 0.85 − tool schemas − output reserve):

```
  0 ──────────────── 70% ──────────────── 100% ──────────►
  nothing            compact stale        drop oldest
                     tool results         history turns
```

Below 70% nothing is cut, because there is nothing to save and every cut risks a recovery
fetch costing a whole step. Between 70% and 100% stale results are compacted, with results
under 4,000 chars left inline. Above 100% whole history turns are dropped, oldest first.

Both thresholds now move with the user's setting: a 200K cap starts compacting at a lower
absolute token count than a 1M cap, which is what choosing 200K is *for*.

---

## Related

- `docs/TOOL_RESULT_TRUNCATION_RESEARCH.md` — why compaction needed a trigger at all
- `docs/AGENT_COST_ANALYSIS_2026-09.md` — the spend that motivated it
- `docs/TOOL_RESULT_TRUNCATION_STRATEGY.md` — the per-payload category design
- Enhancement 77 in CLAUDE.md — where the 200K/400K/1M control came from
