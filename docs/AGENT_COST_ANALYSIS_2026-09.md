# Agent Cost Analysis — August–September 2026

**Window:** 2026-08-01 → 2026-09-11
**Source:** active namespace `chats.db` (`~/.paprwork-v2/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V/chats.db`, 3.2 GB)
**Status:** Part 1 (cost structure) and Part 2 (`get_full_tool_result`) complete. Part 4 lists what remains.

> **Figures revised 2026-09-11 after CLAUDE.md Issue 90.** The first edition of this
> document read costs that had been computed by billing each cached token twice — the
> provider's reported prompt total was charged at full price and then the cache read/write
> surcharges were added on top of it. Every dollar figure in Part 1 has been recomputed
> from `messages.cost` after the backfill
> (`scripts/recompute-message-costs.ts`). The direction of every conclusion is unchanged;
> the magnitudes are sharper. Turn and chat counts moved slightly because a few turns
> landed after the original snapshot. Token counts were never affected.
>
> One claim was **wrong, not merely imprecise**, and is corrected below: the original
> reconciliation was read as confirming `CostCalculation.ts`. It could not, because the
> estimate and the recorded figure were produced by the same faulty arithmetic.
>
> **Read every dollar figure here as a lower bound.** A second defect, found while
> revising this document, records each turn as its *final step* rather than the sum of its
> billed requests — see "Measurement blind spot 2". It understates multi-step turns by
> roughly their step count, so it runs opposite to the double-count and the two partly
> cancelled. That is not yet fixed.

---

## Summary

$3,017.76 across 1,327 assistant turns in 321 chats. Three facts shape everything that
follows:

1. **94% of spend is context handling, not generation.** Cache reads alone are 64% of
   opus-5 spend; output tokens are 6%, and genuinely new input is 0.1%. The unit of cost
   is therefore *a step*, because every step re-sends the whole context — not *a payload*,
   which is what truncation optimizes for.
2. **Spend is extremely concentrated.** 10 of 321 chats account for 70% of it.
3. **13.5% of turns recorded no cost at all**, so the recorded total understates reality —
   and understates it specifically on the expensive turns. Fixed in
   [PR #164](https://github.com/Papr-ai/paprwork/pull/164). The turns already affected
   cannot be repaired: their prompt totals were overwritten, so the tokens are gone.

The first completed deep-dive, `get_full_tool_result`, found that **98% of its 7,561
successful calls recovered a tool result the model already had in full during that same
turn.** The cause is our own mid-turn compaction, which cuts results to 400 characters one
step after they arrive, with no context-pressure threshold. Estimated waste: **~$233** in
redundant cache reads.

---

## Part 1 — Where the money goes

### By model

| Model | Turns | Recorded | Prompt total | Cache read | Output | Turns w/ no cost |
|---|---:|---:|---:|---:|---:|---:|
| `claude-opus-5` | 914 | **$2,370.78** | 49.8M | 3,045.8M | 6.12M | 123 |
| `claude-sonnet-5` | 163 | $181.51 | 7.0M | 337.2M | 1.14M | 10 |
| `claude-fable-5` | 37 | $174.73 | 0.0M | 94.2M | 0.29M | 5 |
| `gpt-5-6-sol-high` | 43 | $108.76 | 6.5M | 130.9M | 0.38M | 7 |
| `gpt-5-6-sol` | 49 | $75.46 | 4.9M | 90.3M | 0.19M | 10 |
| `gpt-5.6-sol` | 50 | $57.21 | 4.8M | 54.9M | 0.19M | 4 |
| `claude-sonnet-4-6` | 35 | $21.79 | 0.8M | 28.9M | 0.24M | 9 |
| `claude-opus-4-6` | 9 | $18.65 | 0.1M | 5.0M | 0.05M | 2 |
| `claude-fable-5-1` | 17 | $8.72 | 6.3M | 6.3M | 0.04M | 3 |
| others (3 models) | 10 | $0.15 | 0.1M | 0.1M | 0.01M | 6 |
| **Total** | **1,327** | **$3,017.76** | **80.4M** | **3,793.6M** | **8.65M** | **179** |

`claude-opus-5` is 69% of turns and **79% of spend**.

The "Prompt total" column is the provider's reported figure, which *includes* the cached
portion — it is not new input. That distinction is what the old cost arithmetic got wrong,
and it is why `claude-fable-5-1` fell from $71.99 to $8.72: its prompt total was almost
entirely cache reads, the cheapest token there is, being re-billed at full price.

### The token mix is the story

| | Tokens | Ratio to new input |
|---|---:|---:|
| Genuinely new input | 16.7M | 1× |
| **Cache read** | **3,793.6M** | **227×** |
| Cache write | 135.9M | 8.1× |
| Output | 8.65M | 0.5× |

"Genuinely new input" is the prompt total minus its cached portion, computed per row —
not the prompt column summed, which double-counts every cached token. For every token of
genuinely new input we re-read **227** tokens of context we had already sent. That is not
a defect by itself — it is what prompt caching is *for*, and a ratio that high means
caching is working. It does mean the cost curve is driven almost entirely by **how many
times context is re-sent**, i.e. step count.

This figure is a lower bound. Issue 85 overwrote the prompt totals on 1,291 rows in this
window, and on those rows the cached portion cannot be subtracted, so their new-input
share is whatever the corrupted total happened to be. The cache read and write columns
accumulated correctly and are unaffected.

### The cost decomposition

Applying list prices to `claude-opus-5` ($5/M input, $0.50/M cache read at the 10%
multiplier, $6.25/M cache write at 1.25×, $25/M output):

| Component | Estimated | Share |
|---|---:|---:|
| Genuinely new input | $2 | 0.1% |
| **Cache read** | **$1,523** | **64%** |
| Cache write | $692 | 29% |
| Output | $153 | 6% |
| **Sum** | **$2,371** | |
| **Recorded in DB** | **$2,371** | ✅ exact |

**The conclusion: 93% of spend (cache read + write) is the cost of carrying context
between steps.** Optimizing payload *size* attacks the 0.1% column. Optimizing *step
count* attacks the 93%. This is the single most important framing for any future cost
work here, and the correction has made it starker: new input is not a tenth of the bill,
it is a rounding error.

#### A reconciliation that confirmed nothing

The first edition of this document reported the same "✅ exact" match and drew the wrong
inference from it — that the match "confirms both the pricing model and
`CostCalculation.ts`." It confirmed neither. Both sides of that comparison were computed
by the same faulty arithmetic: the estimate charged the summed prompt column at full
price, and so did the code. Agreement between two applications of one formula says
nothing about whether the formula is right.

What made the error visible was not a reconciliation but an **inequality**: a prompt total
of 48.5M cannot be "fresh input" when the same rows report 3,155M cached tokens that the
provider includes *inside* that total. The figures above still reconcile exactly, but now
the estimate subtracts the cached portion per row, so the match is a genuine check rather
than a restatement.

The general lesson is worth keeping: a cross-check only has power when the two sides are
derived **independently**. If both come from the same assumption, a match confirms the
assumption is applied consistently — not that it is true.

### Spend is concentrated in a handful of chats

| Band | Recorded | Turns | Share of spend |
|---|---:|---:|---:|
| Top 1 chat | $411 | 97 | 14% |
| Top 5 chats | $1,430 | 455 | 47% |
| **Top 10 chats** | **$2,121** | **709** | **70%** |
| Top 25 chats | $2,594 | 895 | 86% |
| All 356 chats | $3,018 | 1,327 | 100% |

**3% of chats drive 70% of spend.** Average cost per turn is $2.27 overall and $2.99
inside the top 10 — so the concentration is driven more by *turn volume per chat* than by
unusually expensive individual turns. Long-running chats are the cost unit, which matches
the cache-read finding: the longer a chat runs, the more context each step re-sends.

### Measurement blind spot: 179 turns billed as free

179 turns (13.5%) recorded `cost = 0`, including **123 on `claude-opus-5`** — the most
expensive model — with zero errors against them. They succeeded and were simply not
billed into the database.

Root cause: providers report usage **cumulatively per stream**. A continued turn (plan
continuation or wrap-up) opens a *second* stream whose totals restart at zero, and
`AgentService` assigned rather than accumulated, so the continuation's figures replaced
the first stream's. When a continuation reported no usage, a turn that had spent millions
of cache-read tokens recorded nothing.

Because continuations only happen on long multi-step turns, the blind spot is **biased
toward the most expensive turns**. Recorded spend therefore understates reality by more
than 13.5% suggests. Fixed in [PR #164](https://github.com/Papr-ai/paprwork/pull/164) via
`turnUsageAccounting.ts`; see CLAUDE.md Issue 85. **Expect recorded spend to rise after
that merges** — the numbers becoming honest, not costs increasing.

The damage already recorded is **permanent**. Overwriting is not the same as omitting: on
1,291 rows in this window the prompt total was replaced by a smaller figure while the
cache counters kept accumulating, leaving a row whose reported prompt is *less than* the
cached portion it is supposed to contain. No recompute recovers the original, which is
why the Issue 90 backfill deliberately left those rows untouched — it corrected the 248
rows whose token data was still internally consistent and reported the rest as
unrecoverable rather than writing a differently-wrong number over them. Any future
analysis should treat rows satisfying
`prompt_tokens < cache_read_tokens + cache_write_tokens` as untrustworthy.

### Measurement blind spot 2: a turn is recorded as its final step

Every figure in this document is a **lower bound**, and on multi-step turns a severe one.

`AgentService` keeps per-step cache usage by assignment, not accumulation
(`lastCacheReadTokens = cache.cacheReadTokens`), and the stored row falls back to those
values. The premise — that each step's reported usage carries the stream's running total —
is false. Cache *write* disproves it directly: on the 18:00 turn examined in Part 2, step
1 wrote 384,388 tokens and step 4 wrote 1,497. A cumulative counter cannot decrease.
Those are per-request figures, one per billed API call.

The consequence, measured against the four turns that carry `turn_*` metrics:

| Steps in turn | Stored prompt | Stored cost | If steps were summed |
|---:|---:|---:|---|
| 1 | 341.5K | $2.158 | same — nothing to sum |
| 7 | 388.1K | $0.211 | ~$3.02 from the logged steps alone |
| 39 | 369.6K | $0.238 | ~39 requests of 370K ≈ **$7** |

A 39-step turn storing the same token count as a 7-step turn is the tell: the number does
not scale with steps because only the last one is kept. Anthropic bills per request, so
the turn's real cost is roughly the sum across its requests.

**This runs opposite to the double-count**, which inflated the rate applied to whatever
quantity was recorded. One error multiplied, the other truncated, and they partly
cancelled — which is precisely why the original figures looked credible enough to be
reported as "✅ exact". The Issue 90 backfill corrected the *rate*; the *quantity* is still
one step. Recorded spend should therefore be read as "cost of the final step of each
turn", and the true total is materially higher than any figure in this document.

Not yet fixed. Fixing it needs a decision the data alone cannot settle: whether to
accumulate per-step usage ourselves or read a provider-summed total, which requires
confirming what `totalUsage` reports for cache fields in the installed AI SDK.

### Tool payload ranking

| Tool | Calls | Chars stored | Per call |
|---|---:|---:|---:|
| `bash` | 13,574 | 39.4M | 2,902 |
| **`get_full_tool_result`** | **7,590** | **29.4M** | **3,873** |
| `read_file` | 2,932 | 11.2M | 3,820 |
| `search_agent_memory` | 151 | 9.6M | **63,576** |
| `edit_file` | 2,291 | 9.0M | 3,928 |
| `webview_launch_app` | 225 | 5.3M | 23,556 |
| `validate_app` | 198 | 5.0M | 25,253 |
| `webview_snapshot` | 112 | 3.9M | 34,821 |

Two things to note. `get_full_tool_result` is the **second-largest payload in the corpus**
despite doing no work — and at 3,873 chars per call it averages *more* than a `bash` result
(2,902), which is the first clue to Part 2. Separately, `search_agent_memory` averages
**63,576 chars per call**, by far the largest per-call payload of any tool, and is
currently uncapped.

---

## Part 2 — Area 1 results: `get_full_tool_result`

### Why it was investigated

The tool went from **414 calls (Feb–Jul)** to **7,559 calls (Aug–Sep)** — a 18× jump that
made it the #2 payload in the corpus at ~29.4M chars (~7.4M tokens). The starting
hypothesis was that the agent was using it to read whole codebases or very large files
instead of grepping.

**That hypothesis was wrong**, and the actual cause is self-inflicted.

### Finding: 98% of calls recover something the model already had

| Original size recovered | Calls | Share | Chars returned | Was the fetch necessary? |
|---|---:|---:|---:|---|
| Under 2K | 4,763 | 63% | 6.5M | **No** — never near any cap |
| 2K – 40K | 2,648 | 35% | 15.9M | **No** — under the 40K fresh ceiling |
| 40K – 256K | 115 | 1.5% | 5.8M | Yes — mid-turn cap applied |
| Over 256K | 35 | 0.5% | 1.3M | Yes — sidecar offload |

**7,411 of 7,561 (98%)** recovered a result under the 40,000-char fresh ceiling — meaning
the model would have had it in full had the batch still been fresh. 7,553 fetches were
**in-flight** (same turn) against only 8 reaching into persisted history, so this is not a
cross-session memory feature being used; it is a within-turn repair.

### The mechanism

A real call pair from 2026-09-11:

| Step | Event | Context effect |
|---|---|---|
| 1 | Agent runs `bash` | 796 chars, complete — nowhere near the 40,000 ceiling |
| 2 | Agent runs one more tool | bash batch goes stale (`keepLastBatches: 1`) |
| 3 | Compaction cuts it | **400 chars** + `get_full_tool_result` pointer — saves 396 |
| 4 | Agent fetches it back | returns **1,041 chars** |
| 5 | That fetch is its own step | entire context (~63K tokens) re-sent |

The recovered copy is **larger than the original it restores** (~1.2–1.3×) because it
returns JSON-escaped inside
`{success, data:{toolName, toolCallId, messageId, chatId, totalLength, result}}`.
Observed pairs: 796→1,041 · 1,109→1,361 · 2,435→2,729. This is also visible in aggregate:
3,873 chars per `get_full_tool_result` call against 2,902 per `bash` call.

**Net:** context holds `400 + 1,041 = 1,441` chars where doing nothing would have cost
`796`. Compaction saved 396 characters and spent 1,441 undoing it — plus a full extra step.

### Root cause in code

Two settings combine:

```ts
// src/gateway/services/agent/compactToolResults.ts:47
const DEFAULTS = {
  keepLastBatches: 1,                              // every new call stales the previous one
  maxStaleLength: 2000,
  maxFreshLength: ABSOLUTE_TOOL_RESULT_MAX_CHARS,  // 40,000
};
```

`resolveMidTurnToolResultCharLimit` then returns `Math.min(batchCeiling, historyLimit)`,
and for `bash` the aggressive category limit is `HISTORY_TOOL_RESULT_MAX_CHARS = 400`. So
a stale bash result mid-turn becomes `min(2000, 400)` = **400 chars**.

And the gate is a boolean, not a threshold:

```ts
// src/gateway/services/agent/compactToolResults.ts:446
if (!truncationSettings.midTurnCompactionEnabled) {
  return;
}
```

There is no check of context fill. Compaction fires identically at 31% and 95%. The
asymmetry with the very next line at the main call site is the giveaway:

```1364:1368:src/gateway/services/AgentService.ts
      compactStaleToolResults(messages);
      const preFlightTrim = trimOldestHistoryTurns(messages, {
        ...historyTrimBounds,
        maxTokens: historyTokenBudget,
      });
```

Trimming is budget-aware. Compaction is not. `bash` itself adds no truncation and emits no
pointer (`src/core/tools/bash.ts:732`, `:1021` — *"no truncation - prepareStep keeps last
full"*), so **every recovery pointer the agent ever saw was inserted by compaction.**

### It is a constant tax, not a long-turn pathology

Recovery share by turn size in chat `01eed089`:

| Tool calls in turn | Turns | Tool calls | Recovery fetches | Share |
|---|---:|---:|---:|---:|
| 1–15 | 29 | 267 | 63 | 23.6% |
| 16–40 | 19 | 426 | 107 | 25.1% |
| 41–80 | 17 | 955 | 196 | 20.5% |
| 80+ | 8 | 915 | 150 | 16.4% |

Flat at 16–25% regardless of turn length — roughly **one fetch per four tool calls**, which
is exactly what a one-batch fresh window predicts. It is also **model-independent**
(opus-5 68% of turns affected, sonnet-5 98%, gpt-5.6-sol 100%, sonnet-4-6 94%), which
rules out model habit and confirms the harness as the cause.

### The three heaviest chats

| Chat | User msgs | Assistant turns | Tool calls | Biggest single turn | Recovery | Share |
|---|---:|---:|---:|---:|---:|---:|
| Add papr-embed-v1 Models to Patent Application | 101 | 79 | 2,563 | 171 | 516 | 20.1% |
| Feedback on Demo Day Pitch Hooks | 63 | 61 | 1,072 | 82 | **333** | **31.1%** |
| Help me find the previous chat session | 84 | 79 | 3,223 | 125 | 286 | 8.9% |

Tool mix in the patent chat: `bash` 973 (38.0%), `get_full_tool_result` 516 (20.1%),
`read_file` 357 (13.9%), `write_file` 217 (8.5%), `edit_file` 173 (6.7%). The pitch chat is
worse proportionally — `bash` 536 plus `get_full_tool_result` 333 is 81% of its tool calls.

Notably these are **document and pitch chats, not code chats**, which further undercuts the
"reading large source files" hypothesis.

### What it was *not*

- **Not whole-codebase reads.** The largest single fetch (5.6MB) came from a grep that was
  *already* bounded — with `| head -260`. `head -N` bounds **lines, not bytes**, and
  bundled files under `ui/` contain single lines megabytes long.
- **Not `parse-server`.** No evidence in any large fetch.
- **`hne-train-a100`:** one 1.37MB fetch, the stdout of an
  `ssh … 'cd ~/memory-pr-v61 && …'` remote command — not a file read.

### Cost attribution

~7,411 redundant fetches, each costing one extra step at ~63K tokens of re-sent context:

```
7,411 steps × 63,000 tokens  ≈ 467M cache-read tokens
467M × $0.50/M (opus-5 cache read)  ≈ $233
```

That is ~9% of opus-5 spend for the window, and it is a **lower bound** — it counts only
the cache-read cost of the extra step, not the output tokens spent deciding to make the
call, nor the cache-write churn from mutating history mid-turn, nor the step-budget
displacement (a turn spending 20% of `maxSteps` on recovery has 20% less room to finish).

### Fix status

- **Shipped** in [PR #164](https://github.com/Papr-ai/paprwork/pull/164): recovered
  payloads no longer stay full in history forever, and continuation usage is accumulated
  rather than overwritten. This addresses the symptom and the measurement gap.
- **Not yet fixed:** the compaction trigger and the stale floor. Three candidates, with
  external backing and predicted effect, are in
  [`TOOL_RESULT_TRUNCATION_RESEARCH.md`](./TOOL_RESULT_TRUNCATION_RESEARCH.md) Part 9. The
  short version: gate compaction on context pressure (largest effect, ~70–75% of the
  history budget) and floor the mid-turn stale limit at ~4K (cheapest). Both are
  one-line-scale changes at a single call site.

---

## Part 3 — How to reproduce this analysis

The database is namespace-scoped and live. Constraints that matter:

```bash
# Resolve the active DB (do not assume the flat legacy path)
DB=~/.paprwork-v2/orgs/<org>/namespaces/<ns>/chats.db

# Read a live/locked DB safely
sqlite3 -readonly "file:$DB?immutable=1" '<query>'
```

- **Bound payload reads** with `length(tool_calls) < 2000000`. An unbounded read of a
  payload column can pull a 100MB value into the heap — the Issue 70 OOM path.
- **Never `SELECT *`** on a table with payload columns.
- **Guard JSON extraction** with `json_valid()`; a small number of stored results are not
  valid JSON (9 of 8,101 in this corpus).
- **Keep queries aggregate-only.** Counts, sums and group-bys over tool *names* and sizes
  answer every question in this document without extracting or printing any message
  content.
- In-flight `get_full_tool_result` results resolve to a **sibling tool call in the same
  message**, so the original command is reachable by self-joining
  `json_each(m.tool_calls)` on `$.id = $.data.toolCallId`.

Cost columns live on `messages`: `prompt_tokens`, `completion_tokens`, `total_tokens`,
`cost`, `cache_read_tokens`, `cache_write_tokens`.

---

## Part 4 — Remaining areas, in priority order

| # | Area | Why | Signal so far |
|---|---|---|---|
| 1 | **Compaction trigger** | The 93% column. Largest single lever found. | Unconditional; every peer gates on fill |
| 2 | `search_agent_memory` | Largest per-call payload of any tool, uncapped | 151 calls, 63,576 chars/call |
| 3 | `introspect_memory_graph` | Uncapped; memory-graph payloads are the heaviest per call | Flagged, not yet quantified in this window |
| 4 | **Step count per turn** | The unit of cost. One turn made 171 tool calls. | Biggest turns: 171 / 125 / 82 |
| 5 | `bash` byte bounds | 5.6MB from a `head -260` grep | `head -N` bounds lines, not bytes |
| 6 | Per-chat concentration | 3% of chats = 70% of spend | Worth per-chat budget visibility in the UI |
| 7 | Payload encoding (TOON) | 58.8% reduction on uniform row sets | Only worth it for items 2–3; see research doc Part 7 |

Item 4 deserves emphasis. Given that 93% of spend is context carriage, **reducing steps
per turn is strictly more valuable than reducing bytes per result**, and we currently have
no metric for it. The recommended first instrument is a `redundant-recovery rate`: log when
a fetch recovers a result compaction had just cut, and by how much.

---

## Related

- [`TOOL_RESULT_TRUNCATION_RESEARCH.md`](./TOOL_RESULT_TRUNCATION_RESEARCH.md) — the three
  truncation layers in detail, 2026 research literature, how Claude Code / Codex CLI / LCM
  bound the same thing, the metric set, and the TOON and byte-bound assessments
- [`TOOL_RESULT_TRUNCATION_STRATEGY.md`](./TOOL_RESULT_TRUNCATION_STRATEGY.md) —
  Enhancement 51, the category design
- [`TOOL_PAYLOAD_OFFLOADING.md`](./TOOL_PAYLOAD_OFFLOADING.md) — Issue 70, sidecar design
- CLAUDE.md Issue 85 — usage accounting and the retention split
- Canvas: `tool-result-truncation-loop.canvas.tsx` — the round trip, visualized
