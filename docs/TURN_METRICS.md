# Per-Turn Metrics

**Added:** 2026-09-11

Measures what a turn costs and whether it was any good, locally at full fidelity
and in aggregate across users. Closes the instrument that
[TOOL_RESULT_TRUNCATION_RESEARCH.md](TOOL_RESULT_TRUNCATION_RESEARCH.md) Part 6
identified as the thing to add *before* changing the truncation policy.

---

## Why a turn is the unit

The unit of spend is a **step**, not a payload. Every step in a turn re-sends the
whole context, so 84% of `claude-opus-5` cost over Aug–Sep was context carriage
between steps and only 6% was output. Yet step count was persisted nowhere: the
one number that explains the bill could not be queried.

`paprwork_tool_called` already fires per tool call, which is both too fine (2,563
events for a single chat) and unable to answer "how many round-trips did this
turn take". One rollup per turn is the grain the cost question is asked at.

---

## What is measured

Written to `messages` as nullable INTEGER columns, one row per assistant turn.

| Column | Question it answers |
|---|---|
| `turn_steps` | how many model round-trips this turn took |
| `turn_tool_calls` | tool calls in the turn |
| `turn_duration_ms` | wall clock |
| `turn_compaction_runs` | times mid-turn compaction actually ran |
| `turn_compaction_skips` | times the pressure gate declined |
| `turn_stale_truncated` | stale results actually cut |
| `turn_stale_inline` | stale results left whole under the 4K floor |
| `turn_recovery_fetches` | `get_full_tool_result` calls |
| `turn_redundant_recoveries` | fetches recovering a result that would have fit the fresh ceiling |
| `turn_recovered_chars` | total characters fetched back |
| `turn_peak_context_tokens` | largest whole prompt the provider reported for a step; falls back to the estimate only when no step reported usage |
| `turn_estimated_context_tokens` | the `chars/4` estimate on its own — the truncation ladder's own view |
| `turn_context_budget_tokens` | the budget that applied |
| `turn_plan_total_steps` / `turn_plan_completed_steps` | plan progress at turn end |

Existing columns already carry the other half: `prompt_tokens`,
`completion_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost`, `model`,
plus `context_naive_tokens` / `context_optimized_tokens` from
`contextFootprintStore.ts`.

### Two context numbers, on purpose

`turn_peak_context_tokens` is what was **billed**. `turn_estimated_context_tokens`
is what the truncation ladder **believed**, and on real turns the first is around
1.9× the second: the `chars/4` ratio is too generous for our content (measured
2.83 chars per token overall, 2.72 for tool results), tool-call arguments were
counted as zero until Issue 92, and JSON framing is never counted at all.

Keeping both makes the estimator's error queryable rather than arguable:

```sql
SELECT ROUND(AVG(1.0 * turn_peak_context_tokens / turn_estimated_context_tokens), 2)
FROM messages
WHERE turn_estimated_context_tokens > 0 AND turn_peak_context_tokens > 0;
```

This matters beyond reporting. The same estimate drives the compaction gate,
`trimOldestHistoryTurns`, and the post-trim budget check, so a sustained ratio
above 1 means all three fire later than their thresholds imply. `npm run
calibrate:token-estimator` measures the ratio half directly against a real
tokenizer.

`contextFillRatio` deliberately divides the **estimate** by the budget, not the
billed figure — it reports how full the ladder thought it was, which is the
quantity its own 70% gate compares.

### Redundant recovery

A recovery is **redundant** when the recovered result is at or under
`ABSOLUTE_TOOL_RESULT_MAX_CHARS` (40,000) — the fetch bought back something the
turn was never going to lose. It cost a whole extra step to recover, typically, a
few hundred characters.

98% of 7,561 successful fetches in the Aug–Sep corpus were redundant by this
definition, which is what motivated the pressure gate. Reconstructing that number
required joining `toolCallId` against sibling tool calls in the same message,
which is why the loop went unnoticed for six weeks. Now it is a column.

Each call counts once, including each page of a paginated recovery, because each
page is its own round-trip.

---

## Why columns, not a JSON blob

The point of collecting these is to aggregate them. `AVG(turn_steps)` against a
3GB database should not parse JSON per row, and the `json_extract` route here
needs a `json_valid()` guard because a fraction of stored payloads are malformed.
Nullable INTEGER columns make the migration metadata-only, and turns recorded
before this shipped simply read NULL.

---

## Where the data goes

Three cloud paths exist in this repo. Only one of them is a place cross-user
measurement can live.

| Path | What it carries | Usable for this? |
|---|---|---|
| GCS (`gcsDeploySnapshot.ts`, `gcsSharedCache.ts`) | mini-app deploy artifacts and host caches | **No** — not an analytics store |
| Papr Memory sync (`HybridStorageProvider`) | message content, into *that user's own namespace* | **No** — per-user storage, not aggregable |
| Telemetry (`TelemetryClient`) | anonymous events → `memory.papr.ai` → Amplitude | **Yes** |

So: there is no GCP analytics bucket, and enabling cloud sync does not send
metrics anywhere aggregable — it syncs that user's messages into that user's own
memory namespace. The cross-user path is the telemetry pipeline, which already
carries `paprwork_message_sent` and `paprwork_tool_called`.

`paprwork_agent_turn_completed` rides it: anonymous install ID, opt-in gated,
key held server-side.

### The privacy invariant

Every field on the event is a number, a boolean, or null. No message content, no
tool arguments, no file paths, no tool names. A test iterates the summary shape
and fails on any string field, because a string here would be a channel for
exactly the content this is meant not to carry.

Metrics stay out of the memory sync deliberately: `HybridStorageProvider.recordTurnMetrics`
delegates to the local database and nothing else.

---

## The quality half

Cutting context always reduces tokens and may reduce quality, so a cost metric
without a paired quality metric ranks a degraded agent as an improvement. LOCA-bench
measured exactly that: compaction cut accuracy 38.7% → 36.0% while looking like a
saving.

What is collected here is a **proxy**: whether the plan the turn was working on
finished. `plan_completed` is `true` only when a plan existed and has no pending
steps, `false` when steps remain, and `null` when no plan ran — three states,
because "no plan" is not the same claim as "plan unfinished".

Real accuracy needs a fixed labeled task set run in CI. That is a separate build,
and this does not substitute for it. Treat `plan_completed` as a regression
tripwire, not as a quality score.

---

## Querying it

```sql
-- Is the recovery loop closed? (Should trend to ~0 after the pressure gate.)
SELECT model,
       SUM(turn_redundant_recoveries) AS redundant,
       SUM(turn_tool_calls)           AS tool_calls,
       ROUND(1.0 * SUM(turn_redundant_recoveries) / NULLIF(SUM(turn_tool_calls), 0), 4) AS rate
FROM messages
WHERE role = 'assistant' AND turn_steps IS NOT NULL
GROUP BY model ORDER BY redundant DESC;

-- Does the pressure gate actually fire?
SELECT SUM(turn_compaction_runs)  AS ran,
       SUM(turn_compaction_skips) AS gated
FROM messages WHERE role = 'assistant';

-- Cost per step, the number the ladder is trying to move.
SELECT model,
       SUM(turn_steps)                        AS steps,
       ROUND(SUM(cost), 2)                    AS cost,
       ROUND(SUM(cost) / NULLIF(SUM(turn_steps), 0), 4) AS cost_per_step
FROM messages
WHERE role = 'assistant' AND turn_steps > 0
GROUP BY model ORDER BY cost DESC;

-- Plan completion against turn length.
SELECT CASE WHEN turn_steps <= 5 THEN '1-5'
            WHEN turn_steps <= 20 THEN '6-20'
            ELSE '21+' END AS bucket,
       COUNT(*) AS turns,
       SUM(CASE WHEN turn_plan_total_steps > 0
                 AND turn_plan_completed_steps = turn_plan_total_steps
                THEN 1 ELSE 0 END) AS plans_finished
FROM messages
WHERE role = 'assistant' AND turn_plan_total_steps > 0
GROUP BY bucket;
```

---

## Files

- `src/gateway/services/agent/turnMetrics.ts` — collector, classification, summary
- `src/gateway/services/storage/turnMetricsStore.ts` — migration and write
- `src/core/tools/context.ts` — ambient `turnMetrics` on the tool context
- `src/core/tools/chatHistory.ts` — records the recovery at the point of recovery
- `src/core/telemetry/events.ts` — `AgentTurnCompletedProperties`
- `tests/turn-metrics.test.ts` — 15 tests, including the no-content invariant

## Related

- [TOOL_RESULT_TRUNCATION_RESEARCH.md](TOOL_RESULT_TRUNCATION_RESEARCH.md) — Part 6 proposed this instrument
- [AGENT_COST_ANALYSIS_2026-09.md](AGENT_COST_ANALYSIS_2026-09.md) — the measurement that motivated it
- CLAUDE.md Issue 86 — the pressure gate this makes measurable
