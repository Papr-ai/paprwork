# Prompt Cache & Cost Optimization

**Added:** 2026-06-12  
**Status:** Partially implemented — see checklist below

## Summary

Paprwork spends most LLM cost on **repeated prefix content**: system prompt (~50–120K chars), tool schemas (~70 tools), and tool results in history. Prompt caching makes stable prefixes ~**10× cheaper** on cache reads (typically 0.1× input price).

Analysis of **97,352 tool calls** across **1,792 chats** shows **24% redundancy** (same tool+args repeated within a chat). The biggest wins are:

1. **Enable Anthropic cache breakpoints** (done for API-key path)
2. **Keep stable file reads full in history** when actively editing (done)
3. **Truncate noise aggressively** — bash, lists, validation (done)
4. **Reduce redundant tool calls** — especially `read_app_file`, `list_jobs`, browser snapshots (todo)

Run the analysis yourself:

```bash
npm run analyze:tool-calls              # last 300 chats (default)
npm run analyze:tool-calls -- --limit 500
npm run analyze:tool-calls -- --json
CHATS_DB=/path/to/chats.db npm run analyze:tool-calls
```

---

## What Is Implemented

### 1. Anthropic prompt cache (API key path)

**Files:** `src/gateway/services/agent/promptCacheControl.ts`, `src/gateway/services/AgentService.ts`

| Breakpoint | TTL | Content |
|------------|-----|---------|
| System message | 1h | Full system prompt (if ≥16K chars) |
| Last message | 5m | Incremental conversation prefix |

- Applied on initial `streamText` call and re-applied in `prepareStep` each multi-step turn
- **Skipped for OAuth/pi-ai** — pi-ai path does not use AI SDK `providerOptions.anthropic.cacheControl`
- Logs `cacheReadTokens` / `cacheWriteTokens` in `onStepFinish`

### 2. Category-based history truncation

**Files:** `src/gateway/services/agent/toolResultTruncation.ts`, `historyFormatter.ts`

- System prompt is **never mutated per turn** (cache-safe)
- **Active working set:** removed — **file reads stay full** in history for prompt cache stability; compression handles context overflow
- **Noise truncated to 400 chars:** bash, directory lists, validation, webview/browser snapshots
- **Edits kept full:** small, high-signal
- Full results always in SQLite + `get_full_tool_result`

See [TOOL_RESULT_TRUNCATION_STRATEGY.md](./TOOL_RESULT_TRUNCATION_STRATEGY.md).

---

## Chat History Analysis (2026-06-12)

**Database:** `~/.paprwork-v2/chats.db` — 1,792 chats, ~2GB  
**Sample:** Last 300 chats (1,272 messages with tools, 22,669 tool calls)

### Global volume (all chats)

| Metric | Value |
|--------|-------|
| Total tool calls | **97,352** |
| Redundant within chat (sample) | **5,455 / 22,669 (24.1%)** |
| Cache-candidate redundant | **1,431** |
| File-read redundant repeats | **737** |

### Top tools by volume — cache-worthy vs noise

| Tool | Global calls | Tag | Recommendation |
|------|-------------|-----|----------------|
| `bash` | 57,224 | **noise** | Truncate to 400 chars ✅; discourage re-grep loops via guidance |
| `read_app_file` | 5,419 | **cache-worthy** | Keep full in history ✅ (prompt cache + no re-read loops) |
| `edit_app_file` | 3,937 | high-signal | Keep full ✅ |
| `update_plan` | 3,136 | moderate | 2KB limit ✅ |
| `webview_execute` | 2,575 | **noise** | Truncate ✅ |
| `read_file` | 1,757 | **cache-worthy** | Same as app reads |
| `list_app_files` | 897 | **noise** | Truncate ✅ |
| `read_job_file` | 891 | **cache-worthy** | Same as app reads |
| `validate_app` | 676 | **noise** | Truncate ✅ |
| `search_files` | 451 | **noise** | Truncate ✅ |
| `browser_snapshot` | (95 repeats/chat max) | **noise** | Truncate ✅; batch testing guidance |

**58.8% of all tool calls are `bash`** — mostly exploratory noise. Truncating bash output in history is the single largest context savings lever after prompt caching.

### Most repeated patterns (within a single chat)

These are the highest-impact redundancy targets — agent calls the same thing dozens of times because truncated history hides prior results:

| Repeats | Pattern | Fix |
|---------|---------|-----|
| 229× | Same `read_app_file` (one app file) | Active working set + full history read |
| 190× | Same `edit_app_file` | Usually legitimate iteration; keep full edits |
| 95× | `browser_snapshot:{}` | Truncate + "you already have snapshot" nudge |
| 69× | `list_jobs:{}` | Truncate + cache list in turn or tool reminder |
| 57× | `validate_app` same appId | Truncate; batch validation guidance |
| 47× | `list_app_files` same appId | Truncate; results rarely change mid-turn |

---

## Full Recommendation Checklist

### A. Prompt caching (high impact, low risk)

| # | Recommendation | Status | Impact |
|---|----------------|--------|--------|
| A1 | Anthropic `cacheControl` on system prompt (1h TTL) | ✅ Done | ~10× cheaper system prefix after first turn |
| A2 | Anthropic `cacheControl` on last message (5m TTL) | ✅ Done | Cheaper incremental history prefix |
| A3 | Re-apply cache breakpoints in `prepareStep` | ✅ Done | Multi-step tool loops stay cached |
| A4 | Log cache read/write tokens per step | ✅ Done | Observability |
| A5 | **OAuth/pi-ai path cache** — investigate pi-ai Anthropic cache headers | ⏳ Todo | ChatGPT OAuth users miss cache today |
| A6 | **Cache tool schemas** — mark last tool definition with `cacheControl` | ⏳ Todo | ~70 tools ≈ 8–10K tokens; stable across turns |
| A7 | Surface cache metrics in UI (context efficiency panel) | ⏳ Todo | Helps users/models tune behavior |

### B. Keep prefix stable (critical for cache hits)

| # | Recommendation | Status | Impact |
|---|----------------|--------|--------|
| B1 | **Never inject per-turn content into system prompt** | ✅ Done | Prefix must be byte-identical |
| B2 | **Memory bootstrap** — one-time session inject (chat start / 2h idle), not every turn | ✅ By design | Minor turn-2→3 prefix shift only |
| B3 | **Stable conversation summary format** — compress earlier turns to fixed template | ✅ Partial | Summary injection is stable text when unchanged |
| B4 | **Avoid reordering messages** between turns | ✅ Done | Chronological load only |

See [Memory bootstrap — how it actually works](#memory-bootstrap--how-it-actually-works) below.

### C. History truncation (context + cache synergy)

| # | Recommendation | Status | Impact |
|---|----------------|--------|--------|
| C1 | Category limits (bash 400, edits full, etc.) | ✅ Done | Cuts context bloat |
| C2 | File reads full in history (all turns) | ✅ Done | Stable prefix → cache reads; compression handles overflow |
| C3 | Full stable reads enable **cache hits** on unchanged file content | ✅ Done | 1 full read >> 5 truncated re-reads |
| C4 | Actionable truncation notices (`get_full_tool_result`) | ✅ Done | Agent can recover when needed |
| C5 | **Extend active set to 2 turns** for files edited but not re-edited | ⏳ Optional | Trade-off: more context vs fewer re-reads |
| C6 | **Code summary tools** at 2KB — consider full for `get_file_code_summary` on active files | ⏳ Optional | 737 file-read redundancies suggest value |

### D. Reduce redundant tool calls (agent behavior)

| # | Recommendation | Status | Impact |
|---|----------------|--------|--------|
| D1 | Tool result: "You read `{path}` N turns ago; content unchanged" on repeat `read_app_file` | ⏳ Todo | Directly targets top redundancy |
| D2 | Debounce `list_jobs` / `list_apps` within same assistant turn | ⏳ Todo | 69× repeats observed |
| D3 | Batch browser testing guidance — one snapshot per state change | ⏳ Todo | 95× `browser_snapshot` repeats |
| D4 | `validate_app` after edits only, not every iteration | ⏳ Prompt | 57× repeats per app |
| D5 | Hybrid grep already runs memory search — reinforce in prompt | ✅ Partial | Reduces blind bash grep |

### E. Model & routing cost

| # | Recommendation | Status | Impact |
|---|----------------|--------|--------|
| E1 | Model-aware context thresholds (GPT-5.4 200K vs Claude 120K) | ✅ Done | Fewer emergency compressions |
| E2 | Auto-summarization before context limit | ✅ Done | Avoids failed turns |
| E3 | Cheaper model for summarization (`cheapSummarizerModel`) | ✅ Exists | Lower compression cost |
| E4 | Default provider resolution (OAuth > API key > Ollama) | ✅ Done | Avoids failed retries |

---

## Memory bootstrap — how it actually works

Bootstrap is **not** a per-turn feature. It runs at **chat start** or after **~2 hours idle**, and injects **once** per session.

**Source:** `src/gateway/services/UserMemoryContextService.ts`

### When it triggers

| Condition | Bootstrap? |
|-----------|------------|
| First user message in a new chat | ✅ Yes |
| User returns after **≥2h** since last message | ✅ Yes (new session) |
| Normal back-and-forth within 2h | ❌ No |

### Two-turn deferred pattern (does not block first reply)

```
Turn 1 (trigger)     → starts background Papr fetch, injects NOTHING
Turn 2 (inject)      → injects goals + use cases + sync tiers + related memory
Turn 3+              → no bootstrap (state.injected = true)
```

On the **trigger turn**, `getMemoryContextBlocks()` kicks off a background fetch (Parse goals/OKRs, use cases, Papr sync tiers, message-scoped memory search) and returns `[]` so the first agent response is not blocked.

On the **next turn**, it injects up to **4 synthetic user messages** via `buildModelMessages()` — inserted after the system prompt and conversation summary, **before** chat history:

```
system prompt
[optional conversation summary]
[CROSS-CHAT USER CONTEXT — sync tiers]      ← bootstrap
[RELATED MEMORY — matched to message]       ← bootstrap
[USER GOALS / OKRs]                         ← bootstrap
[USER USE CASES]                            ← bootstrap
… chat history …
current user message
```

### What bootstrap does NOT do

- Does **not** run on every message
- Is **not** persisted to SQLite — blocks exist only in the model payload for that one inject turn
- Does **not** re-fetch on turn 3+ (until 2h idle or new chat)

### Cache impact

Bootstrap is **not** a recurring cache breaker. The only nuance:

| Turn | Prefix |
|------|--------|
| Turn 1 | system + history (no bootstrap) |
| Turn 2 | system + **bootstrap blocks** + history |
| Turn 3+ | system + history (bootstrap gone) |

Turn 2→3 sees a **one-time prefix shrink** when bootstrap blocks drop off. Minor session-start artifact only.

**Optional improvement (low priority):** Persist bootstrap blocks into chat history on the inject turn so turn 3+ keeps a stable prefix — trade-off is ~3–14K extra chars in every subsequent turn.

### Agent page cost accounting

**Before:** `calculateCost()` treated all `prompt_tokens` at full input price — cache reads were over-counted (~10× too high vs real billing).

**After (2026-06-12):**
- `calculateCostWithCache()` bills regular input, cache read (0.1×), cache write (1.25×), and output separately
- Anthropic API-key streams capture cache tokens from `onStepFinish` + `finish-step` usage
- Stored per message: `cost`, `cache_read_tokens`, `cache_write_tokens`
- Agent dashboard totals (`getGlobalCostStats`, context efficiency `actualCost`) sum stored `cost` — automatically cache-aware for new messages

**Not yet cache-adjusted:** Historical messages saved before this change still use flat pricing. OAuth/pi-ai paths do not report cache breakdown yet.

---

**Scenario:** 15KB file (~3,750 tokens) kept **full** in history vs truncated to 400 chars, agent **re-reads 5 times** across turns.

**Cache economics** (Anthropic API key path today; OpenAI/Gemini similar ~10% read / 125% write when caching enabled):

| | Formula |
|---|---------|
| Cache write | `tokens × input_price × 1.25` |
| Cache read | `tokens × input_price × 0.1` |
| Full input (no cache) | `tokens × input_price` |

**Strategy A — full read once + cache hits:** 1× cache write + 4× cache read (turns 2–5)  
**Strategy B — truncate + re-read loop:** 5× full input price (each re-read re-enters context)

The **~3× savings ratio is model-independent** when cache read = 0.1× and write = 1.25×:

```
A = 3,750 × price × (1.25 + 4×0.1) / 1M = 3,750 × price × 1.65 / 1M
B = 5 × 3,750 × price / 1M
B / A ≈ 3.0×
```

### Dollar examples (from `CostCalculation.ts` pricing)

| Model | Input $/MTok | Strategy A (full + cache) | Strategy B (5 re-reads) | Savings |
|-------|-------------|---------------------------|-------------------------|---------|
| Claude Opus 4.6 | $15.00 | **$0.093** | $0.281 | **3.0×** |
| Claude Sonnet 4.6 | $3.00 | **$0.019** | $0.056 | **3.0×** |
| Claude Haiku 4.5 | $0.80 | **$0.005** | $0.015 | **3.0×** |
| GPT-5.5 | $5.00 | **$0.031** | $0.094 | **3.0×** |
| GPT-5.3 Codex | $15.00 | **$0.093** | $0.281 | **3.0×** |
| Gemini 2.5 Flash | $0.30 | **$0.002** | $0.006 | **3.0×** |
| Gemini 3.5 Flash | $1.50 | **$0.009** | $0.028 | **3.0×** |
| Ollama (local) | $0 | $0 | $0 | **3.0× context** |

**Absolute dollars scale with model tier** — Opus re-read loops hurt most in dollars; Flash hurts least. **Relative waste is the same** (~3×) for any model with standard prompt caching.

**Ollama note:** No API cost, but re-read loops still burn **context window** and **latency**. Truncation + re-read is equally bad for local models on throughput.

**OAuth note:** Anthropic OAuth (pi-ai) and ChatGPT OAuth do not yet use our cache breakpoints — Strategy A savings apply fully only on **API key** routes today.

**Rule:** Stable content that repeats across turns should stay **full and unchanged** so prompt cache reads apply. Truncating to "save tokens" often **increases** cost (cloud) or **context pressure** (local) when the agent re-fetches.

---

## Cache-Worthy vs Noise Classification

Used by `scripts/analyze-tool-call-redundancy.mjs`:

### Cache-worthy (keep full or moderate when stable)

- `read_file`, `read_app_file`, `read_job_file`
- `get_project_code_overview`, `get_file_code_summary`, `list_file_code_summaries`
- `list_schemas`, `read_skill`
- `edit_*` / `write_file` (always full — small)

### Noise (truncate aggressively to 400 chars)

- `bash`
- `list_directory`, `list_app_files`, `list_job_files`, `search_files`
- `validate_app`
- `webview_*`, `browser_snapshot`, `browser_navigate`
- `run_job` output (large logs)

### Moderate (800–2000 chars)

- `search_agent_memory`, `query_memory_graph`
- `create_plan`, `update_plan`, CRUD tools
- Code summary listings

---

## Monitoring

After deploying cache + truncation:

1. Watch gateway logs for `[AgentService] Cache usage: read=X write=Y`
2. Run `npm run analyze:tool-calls` monthly — track `redundantPct` trending down
3. Target: **redundantPct < 15%**, **fileReadRedundantCalls** down 50%

---

## Related Docs

- [TOOL_RESULT_TRUNCATION_STRATEGY.md](./TOOL_RESULT_TRUNCATION_STRATEGY.md)
- [ACTIONABLE_TOOL_TRUNCATION.md](./ACTIONABLE_TOOL_TRUNCATION.md)
- [OAUTH_CONTEXT_MANAGEMENT.md](./OAUTH_CONTEXT_MANAGEMENT.md)
