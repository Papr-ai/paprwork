# Tool Result Truncation: How Ours Works, What the Research Says

**Written:** 2026-09-11
**Status:** analysis — no code change proposed here beyond the recommendation in Part 8

This document exists because a cost review found `get_full_tool_result` had grown from
414 calls (Feb–Jul) to 7,559 calls (Aug–Sep), becoming the second-largest tool payload in
the corpus at ~8M tokens. The obvious explanation — the agent reading whole codebases —
turned out to be false. The real cause is that our own truncation provokes the fetches.

Two halves: **Parts 1–3** are how our code actually behaves and what it measurably did.
**Parts 4–8** are the external literature and practice, and what they imply for the fix.

---

## Part 1 — How our code works

There are **three independent truncation layers**. Confusing them is easy, and the bug
lives in the one people think about least.

### Layer A: mid-turn compaction (`compactToolResults.ts`)

Runs *inside* a single turn, between steps. Call sites:

| Site | When |
|---|---|
| `AgentService.ts:1364` | `prepareStep` — before **every** AI SDK model call |
| `AgentService.ts:1502`, `:1511` | context-pressure recovery paths |
| `piStreamMemoryWrapUp.ts:78` | pi-ai (OAuth) memory wrap-up |

```ts
// compactToolResults.ts:47
const DEFAULTS = {
  keepLastBatches: 1,                                 // only the newest batch stays fresh
  maxStaleLength: 2000,
  maxFreshLength: ABSOLUTE_TOOL_RESULT_MAX_CHARS,     // 40,000
};
```

A "batch" is the group of tool results from one step. With `keepLastBatches: 1`, **every
new tool call makes the previous one stale.** A stale result is then passed through
`truncateToolMessage` → `resolveEffectiveMaxLen` → `resolveMidTurnToolResultCharLimit`,
which returns `Math.min(batchCeiling, historyLimit)`. For `bash`, `historyLimit` is the
aggressive category limit:

```ts
// toolResultTruncation.ts:22
export const HISTORY_TOOL_RESULT_MAX_CHARS = 400;
```

So a stale bash result mid-turn is cut to `min(2000, 400)` = **400 characters**, plus an
appended `get_full_tool_result({ toolCallId })` pointer.

**The gate is a boolean, not a threshold:**

```ts
// compactToolResults.ts:446
if (!truncationSettings.midTurnCompactionEnabled) {
  return;
}
```

There is no check of how full the context actually is. Compaction fires identically at
31% fill and at 95% fill. This matters because the very next line at the main call site
*is* budget-aware:

```ts
// AgentService.ts:1364-1368
compactStaleToolResults(messages);                     // ← unconditional
const preFlightTrim = trimOldestHistoryTurns(messages, {
  ...historyTrimBounds,
  maxTokens: historyTokenBudget,                       // ← budget-aware
});
```

That asymmetry is the strongest evidence this is an oversight rather than a decision.

### Layer B: cross-turn history truncation (`toolResultTruncation.ts`)

Applied when loading history for a *later* turn. Category-based, settings-overridable:

| Category | Limit | Examples |
|---|---|---|
| aggressive | 400 | `bash`, list tools |
| moderate | 2,000 | code summaries, CRUD |
| memory_search | 800 | `search_agent_memory` |
| file reads | 40,000 | `read_file`, `read_app_file` |
| edits | uncapped | `edit_file`, `write_file` |

Two constants shape *how* it cuts:
- `HEAD_TAIL_TRUNCATION_MAX_CHARS = 2000` — at or below this, cut deterministically
  head+tail, which keeps the prompt prefix cache-stable.
- `RECENT_TURN_RETENTION_COUNT = 4` — a discovery-tool window in which results stay full.

### Layer C: sidecar offload (`toolResultSidecars.ts`)

Storage-side, not context-side. Results over `OFFLOAD_THRESHOLD_CHARS = 256 * 1024` move
to `~/.paprwork-v2/tool-results/<chatId>/<messageId>/<toolCallId>.txt`, leaving a
`OFFLOAD_PREVIEW_CHARS = 40_000` preview. Nothing is discarded; `get_full_tool_result`
follows the pointer. This layer is working as designed and is **not** implicated.

### What `bash` itself does

Nothing. `src/core/tools/bash.ts:732` and `:1021` both carry the comment
*"no truncation - prepareStep keeps last full"*. Bash emits its full output with no
pointer. **Every recovery pointer the agent sees was inserted by Layer A.**

---

## Part 2 — The loop, step by step

A real call pair from 2026-09-11:

| Step | Event | Context effect |
|---|---|---|
| 1 | Agent runs `bash` | 796 chars, complete — nowhere near the 40,000 fresh ceiling |
| 2 | Agent runs one more tool | bash batch becomes stale (`keepLastBatches: 1`) |
| 3 | Layer A cuts it | 400 chars + pointer — **saves 396** |
| 4 | Agent calls `get_full_tool_result` | returns **1,041 chars** |
| 5 | That fetch is its own step | entire context (~63K tokens) re-sent |

The recovered copy is *larger than the original it restores* — about 1.2–1.3× — because it
comes back JSON-escaped inside
`{success, data:{toolName, toolCallId, messageId, chatId, totalLength, result}}`.
Observed pairs: 796→1,041 · 1,109→1,361 · 2,435→2,729.

**Net:** context holds 400 + 1,041 = **1,441** chars where doing nothing would have cost
**796**. Compaction saved 396 characters and spent 1,441 undoing it, plus a full extra
step. The step is the real cost: at ~63K tokens per step and ~7,411 redundant steps,
that is ~467M cache-read tokens, roughly **$233** on opus-5 at cache-read rates.

### Measured scale

From the active namespace `chats.db` (3.2 GB), all `get_full_tool_result` calls:

| Original size recovered | Calls | Share | Chars returned | Fetch justified? |
|---|---:|---:|---:|---|
| Under 2K | 4,763 | 63% | 6.5M | No — never near any cap |
| 2K – 40K | 2,648 | 35% | 15.9M | No — under the fresh ceiling |
| 40K – 256K | 115 | 1.5% | 5.8M | Yes — mid-turn cap applied |
| Over 256K | 35 | 0.5% | 1.3M | Yes — sidecar offload |

**98% (7,411 of 7,561) recovered a result the model would have had in full**, had the
batch still been fresh. 7,553 of the fetches were in-flight (same turn) versus 8 that
reached back into persisted history.

Heaviest chat — `01eed089`, "Add papr-embed-v1 Models to Patent Application":
79 assistant turns, 101 user messages, 2,563 tool calls.

| Tool | Calls | Share |
|---|---:|---:|
| `bash` | 973 | 38.0% |
| `get_full_tool_result` | 516 | 20.1% |
| `read_file` | 357 | 13.9% |
| `write_file` | 217 | 8.5% |
| `edit_file` | 173 | 6.7% |

Recovery share by turn size: 1–15 tools → 23.6% · 16–40 → 25.1% · 41–80 → 20.5% ·
80+ → 16.4%. **Flat.** This is not a long-turn pathology; it is a constant tax of roughly
one fetch per four tool calls, which is exactly what a one-batch fresh window predicts.

It is also **model-independent** — opus-5 68% of turns, sonnet-5 98%, gpt-5.6-sol 100%,
sonnet-4-6 94% — which rules out model habit and points at the harness.

### What it was *not*

- **Not whole-codebase reads.** The largest single fetch (5.6MB) was *already* a grep
  with `| head -260`. It blew up because `head -N` bounds **lines, not bytes**, and
  bundled files under `ui/` have single lines megabytes long.
- **Not `parse-server`.** No evidence in any large fetch.
- **`hne-train-a100`:** one 1.37MB fetch, from an `ssh … 'cd ~/memory-pr-v61 && …'`
  remote command's output — not a file read.

---

## Part 3 — What this costs in quality, not just money

Every recovery fetch is a step the model spends re-acquiring information instead of making
progress. Independent of dollars, that:

1. **Burns the step budget.** `maxSteps` defaults to 100. A turn spending 20% of its steps
   on recovery has 20% less room to finish the task, which is one plausible contributor to
   the "finished working with pending plan steps" class of failure (Issue 73).
2. **Degrades the prompt prefix.** A fetch mutates history, so the next step's prefix
   differs from the last — reducing cache hits on top of adding a call.
3. **Risks fabrication.** A cut result signals *something was here* without saying what.
   The Claude Code issue tracker documents models inventing load-bearing fields after a
   blind head-cut removed them.

---

## Part 4 — How comparable agents bound tool output

A tool result is bounded more than once, so a single number per agent is not comparable.
The columns below separate the moments. Other agents publish a **fresh** cap — applied as
output arrives — and have no distinct second pass; ours is where the 400 lives.

| Agent | Fresh cap, as output arrives | Re-cut later in the same turn | Compaction trigger | Recovering something cut |
|---|---|---|---|---|
| **Claude Code** | `BASH_MAX_OUTPUT_LENGTH` 30,000 chars (150,000 max); `bashOutputMaxChars` raisable to 128,000 | no separate stage | **~98% of context window** | spill to session file + preview |
| **Codex CLI** | 10 KB or 256 lines; `tool_output_token_limit` 16,000 (8,000 recommended) | no separate stage | **configurable, hard cap 90%** | follow-up read |
| **LCM** (research impl.) | extract to disk above 25,000 tokens | `LCM_FRESH_TAIL_COUNT = 32` messages protected | **`LCM_CONTEXT_THRESHOLD = 0.75`** | DAG summary + `lcm_expand` |
| **Paprwork — before the fix** | 40,000 chars (`absoluteMaxChars`) | **400 chars once stale** | **none — every model call** | `get_full_tool_result` pointer |
| **Paprwork — now** | 40,000 chars, unchanged | ≤4,000 stays whole; >4,000 → 400 | **70% of history budget** | `get_full_tool_result` + on-disk sidecar |

Two things stand out, and only the second is the bug:

1. **Our fresh ceiling was never the outlier.** At 40,000 characters it is roughly a third
   more generous than Claude Code's 30,000, and the 796-char result in Part 2 arrived
   complete. An earlier draft of this table put our stale 400 in a column the other rows
   filled with fresh caps, which read as "Claude Code admits 30,000 and we admit 400" —
   untrue of a result the step it runs, and contradicted by Part 2's own walkthrough.
2. **Nobody else compacts unconditionally.** Every system here gates on context fill.
   Claude Code waits until 98%. We had no threshold at all.

**Why the distinction decides the fix.** Read as a limits problem, the remedy is to raise
400 across the board — which would not have stopped the loop, because the loop was caused
by cutting *small* results at *low* fill, not by the ceiling being tight on large ones.
Read as a trigger problem, the remedy is a pressure gate plus a floor below which cutting
cannot pay. That is what shipped, and 55 of 57 results on the first instrumented turn were
left inline as a result.

Codex's own community has litigated the trade-off, and the pro-truncation argument is
worth stating fairly — from r/codex: *"many people seem to assume that when/if this gets
'fixed', performance will improve a lot. But it won't, as polluting the context with
thousands of tokens of tool output will have the exact opposite effect."* That is a real
concern. It argues for a **tight ceiling on large output**, which we have (40,000 fresh).
It does not argue for cutting a 796-char result to 400.

---

## Part 5 — The 2026 research literature

The field has converged on a clear position: **destructive truncation is the wrong default;
lossless eviction with addressable recall is better.** Every system below keeps the raw
record and replaces it in the *view* with a pointer.

### Addressable Recall Compaction — ARC (arXiv 2607.25066)

Maintains an append-only Addressable Store plus a Bounded-Size Active View of pointers.
Results: **99.40% needle-in-haystack exact-answer accuracy vs 88.12%** for the best
baseline; LongBench-v2 Hard 29.97% vs 28.25%.

Its compaction routine is the direct precedent for our fix:

> It truncates older thoughts, **keeps short observations inline, replaces longer
> observations by citations**, and retains the most recent turns verbatim.

*Short observations stay inline.* ARC arrived at the floor independently.

### Context as an Environment — Scroll (arXiv 2608.21690)

> As the working view approaches its budget ρC, the harness evicts stale spans.

Two lessons. First, eviction is **budget-triggered** (`ρC`), not per-step. Second, Scroll
keeps an **eviction index** in the view — a compact map of what has left:

> Where search recovers only what the agent thinks to ask for, the index keeps the agent
> aware of history it can no longer see.

Our pointer is per-result with no index. An agent that cannot see the shape of what it
lost re-derives it — which is consistent with the repeated re-investigation observed in
Issue 59.

The same paper names us by category: *"production agents such as Claude Code, Codex CLI,
and Cursor reportedly employ similar compaction mechanisms **as the context window
approaches its limit**."*

### Agentic Context Management — ACM (arXiv 2607.23809)

Two tools: `manage_context` (compress + offload raw to disk) and `query_memory` (retrieve
precisely). Key property:

> Context management is **agent-initiated**: the agent can invoke compression at any point
> during reasoning, rather than relying on a fixed schedule or an external trigger.

Ours is precisely the fixed-schedule case the paper argues against.

### LOCA-bench (arXiv 2602.07962) — the empirical measurement

Benchmarks strategies under controllable context growth. GPT-5.2-Medium at 128K:

| Strategy | Accuracy | Trajectory length |
|---|---:|---:|
| Baseline | 38.7% | 141 |
| + Tool-result clearing | 40.0% | **181** |
| + Thinking-block clearing | 37.3% | 187 |
| + Context compaction | **36.0%** | 107 |
| + Memory tool | 44.0% | 157 |
| + Programmatic tool calling | **49.3%** | **102** |

Read carefully, this is our bug in benchmark form:

- **Tool-result clearing lengthened trajectories 28%** (141 → 181) for +1.3 accuracy
  points. The agent spends the saved context re-acquiring information.
- **Context compaction *reduced* accuracy** (38.7% → 36.0%) while shortening trajectory.
  Compaction is not free.
- **The best result came from neither** — programmatic tool calling scored highest
  (49.3%) at the shortest trajectory (102), by having the agent filter *before* output
  enters context.

That last row is the strategic lesson: **the cheapest tool output is the output that was
never generated.** Filtering at the source beats truncating after the fact.

### Total Recall (TRACE)

Pointer-based compaction with a `recall(query)` tool: **100% needle recall under forced
compaction versus 0% for truncation**, 94% exact-match at 2-hop versus 4% for narrative
compaction. Its eviction ordering is notable — *oldest tool results first, then tool
calls, then dialogue* — because tool results are both large and highly retrievable.

### Context rot — the counterweight

The case *for* bounding context is real and should not be lost: NoLiMa and DSBC report
multi-task accuracy dropping 55.86% → 25.46% as context grows; the "context tax" work
reports degradation from 1 task to 3 tasks in a shared window. **Bounding context is
correct. Bounding it to 400 characters one step after arrival is not.**

---

## Part 6 — Measuring input quality against output quality

The user's question — *"how can we measure quality of input into output and make sure we
are optimally optimizing input into each step?"* — has an established answer: **never
measure tokens alone.** Cutting context always reduces tokens and may reduce quality, so a
cost metric without a paired quality metric will rank a broken agent as an improvement.

### The metric set

| Metric | Definition | What it catches | Have it today? |
|---|---|---|---|
| **Cache read / fresh ratio** | `cache_read ÷ (cache_read + fresh_in)` | prefix churn, mid-chat model switches | ✅ in `chats.db` |
| **Step efficiency** | `optimal_steps ÷ actual_steps`, capped at 1.0 | loops and dawdling — this bug's signature | ❌ |
| **Accuracy per 1K tokens** | `success_rate ÷ tokens × 1000` | whether cheaper context stayed as good | ❌ |
| **Tokens per resolved task** | `total_tokens ÷ successful_tasks` | end-to-end economics | ❌ |
| **Tool-call F1** | precision/recall against a reference trace | wrong tool, right answer | ❌ |
| **Tool-output token share** | `tool_result_tokens ÷ total_input` | which tools dominate context | ✅ measurable |
| **Redundant-recovery rate** | `fetches recovering an uncut result ÷ tool calls` | this loop, directly | ❌ **proposed** |
| **Invalid tool-use ratio** | bad names/params ÷ calls | schema drift after truncation | ❌ |

Sources: `agent-eval-harness`; LOCA-bench (trajectory length, tool invocations,
tool-output token count); CostBench (ACL 2026 — Cost Gap, Average Normalized Edit
Distance, Exact Match Ratio, Task Completion Ratio, Invalid Tool-Use Ratio).

The TOON benchmark's framing is the most compact version of the idea:
**accuracy-points per 1,000 tokens** (TOON 27.7 vs JSON 16.4). A single number that moves
in the wrong direction if you cut quality to save tokens.

### The instrument to add first

`Redundant-recovery rate`. Today it has to be reconstructed by joining `toolCallId` against
sibling calls in the same message — which is precisely why this went unnoticed for six
weeks. A one-line log at the point of recovery (`recovered N chars that compaction cut to
M`) makes the loop visible and makes any fix measurable.

### Worth noting: the anchor-turn finding

The Context Patterns benchmark measured a **26× spread in fresh input tokens** across
models on the same task, driven entirely by tool-use strategy — Sonnet 4.6 used 191 fresh
input tokens at 100% cache utilisation; GLM-5 used 1,935,379 at 73%. Sonnet achieved it
unprompted by reading all relevant source material first, writing a structured summary,
then proceeding. That pattern is worth making explicit in our system prompt: one wide read
early, cached forever, beats many narrow reads that each mutate the prefix.

---

## Part 7 — Should we use TOON?

**Verdict: yes for list-shaped results, no for tool envelopes, and it does not address
this bug either way.**

TOON (Token-Oriented Object Notation) is real and benchmarked — 5,016 LLM calls across
four frontier models. Average 39.9% fewer tokens than JSON at *slightly better* retrieval
accuracy (76.4% vs 75.0%). But the savings are entirely a function of data shape:

| Data shape | Reduction vs JSON |
|---|---:|
| Flat / uniform tables | 58.8% |
| Time series (60 days) | 59.0% |
| GitHub repo data | 42.3% |
| E-commerce orders (nested) | 33.3% |
| Mixed structures | 21.9% |
| **Agentic tool calling** | **2–18%** |

Two hard constraints:

1. **Prompt tax.** TOON is absent from training data, so it needs instructional overhead
   in the prompt. The payoff threshold is **~20–30 rows of uniform data**; below that the
   header declaration costs more than the omitted keys save. arXiv 2603.03306 confirms
   plain JSON has the best one-shot *generation* accuracy.
2. **Multi-turn fragility.** Agentic tool-calling tests measured only **2–18%** total
   savings with **cascading parse failures in multi-turn loops** — the exact setting we
   run in.

### Applied to us — implemented, and the predictions below were wrong

This section originally named `introspect_memory_graph` ("84,438 tokens/call") and
`list_jobs` as the best candidates. Measuring 244 real stored payloads before writing any
code refuted both, so the numbers here are now measured rather than estimated.

**Bad candidates** — a bash result is
`{success, data:{stdout, stderr, exitCode, command, duration}}`: small, nested, one
instance. That is the 21.9% row at best, below the payoff threshold, and the stdout
payload is unstructured text that TOON cannot compress at all. `webview_snapshot`
(30,795 chars/call) is raw HTML plus visible text, and `list_job_files` (52,041
chars/call, the largest per-call average in the corpus) is an array of path *strings*
with no repeated keys to omit — neither has anything for TOON to remove.

**What the measurement found.** Calling `encode()` on results as they are built made three
of seven list tools *larger* than JSON — `list_jobs` −1.7%, `list_documents` −4.4%,
`validate_app` −3.1% — because TOON only reaches its tabular form when every row carries
the same keys in the same order with scalar values, and ours do not: optional fields are
dropped entirely by `JSON.stringify`, and several carry nested objects. Normalising into a
true table first reaches tabular form on 100% of them.

**Measured at the wired call sites**, comparing *embedded* size (a TOON string inside a
JSON envelope pays two characters per newline, which a raw-string comparison misses):

| Tool | Calls | Gate accepts | Saving when accepted |
|---|---:|---:|---:|
| `validate_app` | 106 | 41 | **36.0%** |
| `list_apps` | 199 | 152 | 20.0% |
| `list_schemas` | 33 | 33 | 26.9% |
| `get_job_history` | 37 | 7 | 34.3% |
| `list_documents` | 200 | 26 | 15.3% |
| `list_jobs` | 192 | 3 | 15.6% |

`list_jobs` is the instructive one: the largest total volume of any list tool (12.85M
chars) and almost never worth encoding, because its rows are mostly free text — commands,
paths, descriptions — where key names are a rounding error. The saving is a property of
the individual payload, not of the tool, which is why `src/core/utils/toonRows.ts`
measures each call and keeps TOON only when it wins by at least 15%. Below that sits
TOON's own agentic-tool-calling band (2–18%, *with* cascading parse failures in multi-turn
loops), where the saving does not pay for handing the model a format it may misread.

**Important:** TOON shrinks the *payload*. This bug is about **how often we cut**, not how
we encode. Even a 58.8% smaller recovery payload still costs a full extra step, which is
the dominant term — so TOON is worth doing on its own merits and is not related to this
fix.

**And the encoding was never where the money was.** Across the same corpus TOON saves
~1.45M characters, while `list_job_files` was spending **6.28M on dependency paths**:
95.5% of its listed entries, and 97.4% of its characters, sat inside `venv/`,
`site-packages/`, `node_modules/` and `__pycache__`, because its directory walk excluded
only `.versions`. The agent's own job scripts arrived buried under ~790 dependency paths
per call. Measuring what a payload *is* beat compressing it by roughly four to one.

---

## Part 8 — Should we add a byte bound?

**Yes, and it is nearly free.**

The largest fetch in the corpus (5.6MB) came from a grep that was *already* bounded:
`| head -260`. `head -N` bounds **lines**, and bundled files under `ui/` contain single
lines megabytes long, so a 260-line bound admitted 5.6MB. This is a real gap, distinct from
the compaction loop.

Two complementary bounds:

| Bound | Effect | Where |
|---|---|---|
| `\| head -c 200000` | hard byte ceiling regardless of line length | prompt guidance + bash tool |
| `--exclude-dir=node_modules --exclude-dir=dist` | stops walking generated trees | prompt guidance |

A byte bound is what Codex and Claude Code both enforce at the harness level (10 KB / 256
lines, ~30,000 chars). Ours is advisory only. The lowest-risk version is prompt guidance
plus a tool-level warning when bash output exceeds a byte threshold *and* the command used
a line-based bound — telling the agent specifically that `head -N` did not do what it
intended.

Note this is an **upstream** fix in the LOCA-bench sense: it is the "programmatic tool
calling" strategy that scored best (49.3% at 102 steps). Output never generated needs no
truncating.

---

## Part 9 — Recommendation

Three candidate changes, in the order the evidence supports:

### 1. Gate mid-turn compaction on context pressure — largest effect

Skip `compactStaleToolResults` below roughly 70–75% of the history token budget. At 31%
fill there is nothing to save and the fetch is pure loss.

- **Backing:** LCM 0.75 · Codex ≤90% · Claude Code ~98% · Scroll `ρC` · ACM's argument
  against fixed schedules.
- **Effect:** removes most of the 7,411 redundant fetches outright.
- **Cost:** one condition at one call site; the budget is already computed on the
  following line as `historyTokenBudget`.
- **Risk:** peak in-turn context rises on long turns before the gate opens. Bounded by
  Layer B and by `trimOldestHistoryTurns`, both of which remain.

### 2. Floor the mid-turn stale limit — cheapest

Never truncate below ~4,000 chars mid-turn. Below that, a recovery fetch provably costs
more than the result it recovers (1,441 > 796 at 796 chars, and the ratio worsens as
results shrink).

- **Backing:** ARC — *"keeps short observations inline, replaces longer observations by
  citations."*
- **Effect:** eliminates the sub-2K bucket, 63% of all fetches.
- **Cost:** one constant in `resolveMidTurnToolResultCharLimit`.
- **Risk:** minimal — leaves aggressive truncation fully intact above 4K, where it pays.

### 3. Widen the fresh tail — supporting

`keepLastBatches: 1 → 3`, so one tool call no longer stales the immediately preceding one.

- **Backing:** LCM protects 32 recent messages.
- **Risk:** raises peak in-turn context more than (2) does; do this only after measuring
  (1) and (2).

### Sequencing

Add the **redundant-recovery log** first (Part 6), then ship (1) and (2) together — they
are independent and mutually reinforcing: (1) decides *whether* to cut, (2) decides *how
far*. Measure the recovery rate before and after. Hold (3) until there is data.

Not in scope here but worth tracking: `search_agent_memory` (29,481 tokens/call) and
`introspect_memory_graph` (84,438 tokens/call) are still uncapped, and are the natural
next target once this loop is closed.

---

## Sources

**Research**
- ARC: Addressable Recall Compaction — [arXiv 2607.25066](https://arxiv.org/pdf/2607.25066)
- Context as an Environment (Scroll) — [arXiv 2608.21690](https://arxiv.org/html/2608.21690)
- ACM: Agentic Context Management — [arXiv 2607.23809](https://arxiv.org/pdf/2607.23809)
- LOCA-bench — [arXiv 2602.07962](https://arxiv.org/html/2602.07962)
- CostBench — [ACL 2026](https://aclanthology.org/2026.acl-long.584.pdf)
- TOON vs JSON generation benchmark — [arXiv 2603.03306](https://arxiv.org/html/2603.03306v1)
- Total Recall / TRACE — [tinkerclaw docs](https://github.com/globalcaos/tinkerclaw/blob/main/docs/papers/total-recall/total-recall.md)

**Practice**
- Claude Code `bashOutputMaxChars` / `taskOutputMaxChars` — [getclaudeskills.com](https://www.getclaudeskills.com/blog/claude-code-bashoutputmaxchars-taskoutputmaxchars-settings)
- Claude Code context window & compaction — [DeepWiki](https://deepwiki.com/anthropics/claude-code/3.3-context-window-and-compaction)
- Claude Code tool result cap issue — [anthropics/claude-code#45770](https://github.com/anthropics/claude-code/issues/45770)
- Codex CLI compaction architecture — [codex.danielvaughan.com](https://codex.danielvaughan.com/2026/03/31/codex-cli-context-compaction-architecture/)
- Codex truncation discussion — [r/codex](https://www.reddit.com/r/codex/comments/1oyxmys/codex_will_truncate_any_bashmcp_tool_output_to/)
- LCM (lossless context management) — [lossless-claude/lcm](https://github.com/lossless-claude/lcm/)
- Agentic context efficiency benchmark — [contextpatterns.com](https://contextpatterns.com/guides/agentic-context-efficiency/)
- agent-eval-harness — [tkarim45/agent-eval-harness](https://github.com/tkarim45/agent-eval-harness)
- TOON — [toon-format/toon](https://github.com/toon-format/toon), [benchmarks](https://json2toon.co/blog/toon-benchmarks-2026), [when not to use](https://json2toon.co/blog/when-not-to-use-toon)

**Internal**
- `src/gateway/services/agent/compactToolResults.ts` — Layer A
- `src/gateway/services/agent/toolResultTruncation.ts` — Layer B
- `src/gateway/services/storage/toolResultSidecars.ts` — Layer C
- `docs/TOOL_RESULT_TRUNCATION_STRATEGY.md` — Enhancement 51, the category design
- `docs/TOOL_PAYLOAD_OFFLOADING.md` — Issue 70, the sidecar design
- CLAUDE.md Issue 85 — the retention split and usage accounting ([PR #164](https://github.com/Papr-ai/paprwork/pull/164))
- Canvas: `tool-result-truncation-loop.canvas.tsx`
