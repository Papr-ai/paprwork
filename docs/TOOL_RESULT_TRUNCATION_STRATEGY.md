# Tool Result Truncation Strategy

**Added:** 2026-06-12  
**Status:** Implemented

## Problem

Tool results can be large (up to 100KB each). Loading them verbatim into LLM context causes `context_length_exceeded` errors. Aggressive uniform truncation (~400 chars) fixes overflow but creates a **re-read loop**:

1. Turn 1: agent reads `dashboard.js` (15KB), edits successfully  
2. Turn 2: history loads that read as 400 chars → agent can't see code  
3. Agent calls `read_app_file` again → pays another full read  
4. Turn 3: that read truncates again → repeat  

We need truncation for **noisy** tools (bash, snapshots) **without** truncating file reads — that breaks prompt cache and triggers re-read loops. Context overflow is handled by **conversation compression**.

## Design Principles

1. **Never mutate the system prompt per turn** — that breaks provider prompt-cache prefix matching and increases cost.
2. **Shape context in history loading only** — `historyFormatter.ts` + `toolResultTruncation.ts`.
3. **Full results stay in SQLite** — UI and `get_full_tool_result` always have complete data.
4. **Category-based limits** — bash vs file reads vs edits behave differently.
5. **File reads stay full in history** — stable prefix for prompt cache reads (~0.1× input); compression handles overflow.

## Architecture

```
Storage (SQLite)          History load (per turn)           Model
─────────────────         ───────────────────────           ─────
Full tool results    →    formatHistoryMessagesForModel  →  File reads: full
100KB max each            + toolResultTruncation.ts          Bash/noise: 400 chars
                          (does NOT touch system prompt)
```

Within a single assistant response, `compactStaleToolResults()` still applies:

- **Fresh batch** (most recent tool round): full up to 50KB  
- **Stale batches** (same turn, earlier steps): 2KB each  

That layer is unchanged; this doc focuses on **cross-turn** behavior.

## File Reads (Full — Cache-Stable)

| Tool | Cross-turn limit |
|------|------------------|
| `read_file`, `read_app_file`, `read_job_file` | **Full** (unchanged in history) |

Keeping reads full lets later turns hit **prompt cache** on the same bytes instead of re-reading from disk at full input price.

## Category Limits (Cross-Turn)

| Category | Tools | History limit |
|----------|-------|---------------|
| **File read** | `read_file`, `read_app_file`, `read_job_file` | **Full** (prompt-cache stable) |
| **File edit** | `write_file`, `edit_app_file`, `edit_app_file_lines`, `edit_job_file` | **Full** (usually small) |
| **Code cache** | `get_project_code_overview`, `get_file_code_summary`, `list_file_code_summaries` | 2KB |
| **Bash / shell** | `bash` | 400 chars (full text for last 4 user turns) |
| **Directory / search** | `list_directory`, `list_app_files`, `search_files`, … | 400 chars |
| **Memory search** | `search_agent_memory`, `query_memory_graph`, … | 800 chars |
| **Recovery** | `get_full_tool_result` | **Full** (always) |
| **Validation / preview** | `validate_app` | **2KB** (actionable error list) |
| **Validation / preview** | `browser_*`, `webview_*` | 400 chars |
| **Job run** | `run_job`, `get_job_logs`, … | 400 chars |
| **Small CRUD** | `create_plan`, `create_app`, `list_schemas`, … | 2KB |
| **Orphan / interrupted** | Missing tool results | **Full** (marker text) |

## Truncation Notices

Truncated results append an actionable notice. Aggressive limits (≤2KB) use **head+tail** truncation (deterministic, cache-stable) so stderr/errors at the end of bash output are preserved:

```
HEAD...[... omitted ...]...TAIL
[... N chars truncated. Tool: get_full_tool_result({ toolCallId: "...", toolName: "bash" }) ...]
```

Agent should prefer `get_full_tool_result` over re-reading unchanged files when a **non-file** result was truncated (bash, snapshots, etc.).

## Source-Level Caps (2026-07-22)

`edit_app_file*` / `validate_app` BUILD FAILED output is capped at **8 issues** in the tool `error` string (errors first). Full lists remain in `data.issues` on `validate_app`. Smaller stable payloads improve prompt-cache write cost without mutating cross-turn history.

## Recommended Agent Workflow

For mini-app / job editing:

1. `get_project_code_overview` or `list_file_code_summaries` for orientation (small, cache-friendly tool calls — **not** system prompt injection)  
2. `read_app_file` when editing (full content stays in history across turns)  
3. `edit_app_file_lines` for changes  
4. Next turn: previous reads remain full — **no re-read needed**  
5. If bash/snapshot output was truncated: `get_full_tool_result({ toolCallId })` before re-running the command  

## Recent-Turn Discovery Retention

Bash, directory listings, and graph introspection stay **full** for the **last 4 user turns** so follow-up questions can reuse fetched data without re-listing or re-introspecting.

Eligible tools/categories:

| Tool / category | Examples |
|-----------------|----------|
| **bash** | curl, grep, sqlite queries |
| **directory_list** | `list_job_files`, `list_app_files`, `list_directory`, `search_files` |
| **discovery (explicit)** | `list_jobs`, `list_apps`, `introspect_memory_graph`, `query_memory_graph` |
| **get_full_tool_result** | **Always full** (recovery payload must survive cross-turn) |

Turn counting: number of user messages **after** the assistant message that contains the tool result. If that count is `< 4`, no truncation is applied (up to `ABSOLUTE_TOOL_RESULT_MAX_CHARS`).

| Constant | Value |
|----------|-------|
| `RECENT_TURN_RETENTION_COUNT` | 4 |

Older discovery/bash results still truncate to 400 chars. Use `get_full_tool_result` for anything older than 4 turns or beyond context limits (compression handles overflow).

## Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `HISTORY_TOOL_RESULT_MAX_CHARS` | 400 | Default aggressive limit |
| `HISTORY_TOOL_RESULT_MODERATE_CHARS` | 2000 | Code summaries, small CRUD |
| `RECENT_TURN_RETENTION_COUNT` | 4 | User turns to keep bash/API results at full fidelity |

## Files

| File | Role |
|------|------|
| `src/gateway/services/agent/toolResultTruncation.ts` | Categories and limits |
| `src/gateway/services/agent/historyFormatter.ts` | Applies truncation when building model messages |
| `src/gateway/services/agent/compactToolResults.ts` | Within-turn batch compaction (unchanged) |
| `src/gateway/services/storage/contextFootprint.ts` | Re-exports constants for efficiency stats |
| `tests/tool-result-truncation.test.ts` | Unit tests |

## Testing

```bash
npm run test -- tests/tool-result-truncation.test.ts
```

## Related Docs

- `docs/TOOL_RESULT_TRUNCATION_FIX.md` — Original 2KB fix (Issue 8)  
- `docs/ACTIONABLE_TOOL_TRUNCATION.md` — `get_full_tool_result` tool  
- `docs/RECENCY_TRUNCATION.md` — Within-turn recency tiers (legacy prepareStep doc)  
- `docs/TOOL_RESULT_TRUNCATION_STRATEGY.md` — **This document**

## Future Enhancements

1. Tool-type-aware stale limits inside `compactStaleToolResults` (bash 2KB, file reads full)  
2. `read_app_file` tool-level nudge when re-reading a path already in chat history  
3. Context footprint stats that simulate active-file retention for efficiency reporting  
