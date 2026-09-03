# Agent Docs — Start Here

Use this as the first context file when building apps, jobs, and automations in Paprwork V2.

---

## Quick Routing

### User wants a dashboard/app/automation outcome
Read in order:
1. `APP_AND_JOBS_GUIDE.md` — Complete pipeline: UI-first → validate data → contracts → jobs → wire app

### User wants external API integration (Amplitude, Stripe, CRM, ads, analytics)
Read:
1. `API_KEY_TESTING_PROTOCOL.md` — Test-first protocol with real examples
2. `APP_AND_JOBS_GUIDE.md` — Phase 2: validate upstream data, then build

### User asks "what should agent do here?" or workflow/orchestration is unclear
Read:
1. `DECISION_TREE_AGENT_CAPABILITIES.md` — Agent Job vs Script Job vs Sub-agent vs Mini-app
2. `QUICK_EXAMPLES.md` — Common patterns with correct/wrong examples
3. `DELEGATION_STRATEGY.md` — When to delegate vs execute directly

### User wants to create specialized/reusable agents
Read:
1. `SUBAGENT_CREATION_GUIDE.md` — Complete guide to creating sub-agents with model selection

### User wants LinkedIn / social / platform login automation
Read:
1. `read_skill({ skillId: "preloaded-social-media-auth" })` — connect policy, job matrix, rate limits
2. Use `connect_platform` → `prepare_browser` → `browser_*` for agent-driven UI work

**Quick rules:**

| Platform | Connect | Python/bash scrape jobs |
|----------|---------|-------------------------|
| **LinkedIn** | Papr Chrome only (never personal Chrome) | `requirements: ["linkedin-api", "playwright"]` + `papr_platform_browser` (CDP :9222) |
| **X, Reddit, Instagram, …** | Personal Chrome → keychain OK; Papr Chrome if sign-in needed | `${TWITTER_*}` / `${REDDIT_*}` / `${INSTAGRAM_*}` + headless Playwright — **no** `reddit-api` / `x-api` CDP |
| **Cloud (non-LinkedIn)** | Vault-synced cookie keys (desktop must push vault while awake) | Same headless path; no Papr Chrome, no :9222 |

### User asks about cloud sync, apps.papr.ai, or jobs while Mac is asleep
Read:
1. `CLOUD_VS_DESKTOP_GUIDE.md` — three sync lanes, scheduler routing, Turso pull on wake
2. `get_cloud_sync_status({ appId?, jobId? })` — start here before debugging

### User asks to "set up my workspace/agent" or onboard workflows
Read:
1. `AGENT_SETUP_WORKFLOW.md` — Interview → configure → scaffold → test

---

## Default Stage Flow (Flexible Guidance)

1. Prototype UI and align on use case.
2. Sample real upstream data before committing schema.
3. Define SQLite + job contracts (write/read models, indexes, retention).
4. Implement and run jobs with small verification runs.
5. Link app to job data source and validate end-to-end UX states.

If the task is tiny and explicit, you may merge steps. Always explain tradeoffs when skipping discovery.

---

## V2 Tool Mapping

| Category | Tools |
|----------|-------|
| **Apps** | `list_apps`, `create_app`, `read_app_file`, `edit_file`, `edit_app_file_lines`, `list_app_files`, `link_app_data_source`, `read_app_data_sources` |
| **Jobs** | `create_job`, `run_job`, `read_job_logs`, `edit_file` |
| **Documents** | `create_document`, `read_document`, `list_documents`, `import_document` |
| **Filesystem** | `read_file`, `write_file`, `edit_file`, `list_directory`, `search_files` |
| **Shell** | `bash` |
| **Memory** | `add_agent_memory`, `search_agent_memory`, `register_schema` |
| **Skills** | `read_skill`, `create_skill` |
| **Delegation** | `delegate_task`, `create_sub_agent`, `list_sub_agents`, `delete_sub_agent` |
| **Planning** | `create_plan`, `update_plan` |
| **Browser** | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_tabs` |
| **Platform Connections** | `connect_platform` (status, request_connect, prepare_browser, refresh) — then `browser_*` |
| **Webview** | `webview_launch_app`, `webview_snapshot`, `webview_execute`, `webview_get_console`, `webview_list`, `webview_close` |
| **Cloud sync** | `get_cloud_sync_status`, `push_cloud_sync`, `repair_cloud_sync`, `inspect_cloud_repo`, `query_cloud_turso` |
| **Plan A DB (replica)** | `papr_db_sync_status`, `papr_db_apply_migration`, `papr_db_apply_migration_replica`, `papr_db_apply_migration_cloud`, `papr_db_migration_parity`, `papr_db_reconcile_sync`, `papr_db_exec` (DML only), `papr_db_push` / `papr_db_pull` (recovery) |

**Cloud sync — three lanes (do not conflate):**

| Lane | What moves | How to fix / push |
|------|------------|-------------------|
| **Git (Sync V3)** | App source + `jobs/{id}/` in **per-app** GitHub repo | `push_cloud_sync({ appId })` or Upload now; verify with `inspect_cloud_repo({ appId })` — **not** namespace `git ls-files apps/` |
| **Turso (Plan A)** | Registry DB schema + rows (`attach_database` / `data-sources.json`) | Schema: `write_file migrations/*.sql` → `papr_db_apply_migration`. Rows: `/api/db/write`, `papr_db_exec`, or Upload now |
| **Vault** | Integration Keys + platform cookies for cloud jobs | Pushes when desktop is **awake** with Cloud Sync on — cloud cannot read local keychain |

**Debugging workflow:** `get_cloud_sync_status` → `push_cloud_sync({ appId })` (git **+** Turso ordered flush, same as Upload now) → `papr_db_*` / `repair_cloud_sync` for DB drift → verify again.

**Vault rule:** Cloud agent jobs use keys from the **cloud vault**, not the desktop keychain. New Platform Connection cookies or Integration Keys only reach cloud after desktop syncs while awake.

**Plan A semantics:** Schema = migration file → `papr_db_apply_migration` (replica → Turso primary → pull). Rows = DML auto-pushes when online. Schema drift → `papr_db_migration_parity` + `papr_db_reconcile_sync` (not `merge_lww`). Legacy duplicate ledger ids (`0001_foo` + `0001_foo.sql`) → `papr_db_reconcile_sync({ action: "dedupe_migration_ledger" })`.

---

## Agent-Docs Index

- `APP_AND_JOBS_GUIDE.md` — Building apps, jobs, and pipelines (consolidated guide)
- `API_KEY_TESTING_PROTOCOL.md` — Test-first approach for external APIs
- `DECISION_TREE_AGENT_CAPABILITIES.md` — Choosing the right execution pattern
- `QUICK_EXAMPLES.md` — Common patterns with correct/wrong approaches
- `DELEGATION_STRATEGY.md` — When and how to delegate work
- `SUBAGENT_CREATION_GUIDE.md` — Creating specialized sub-agents with model selection
- `AGENT_SETUP_WORKFLOW.md` — Onboarding and workspace setup
- `CLOUD_VS_DESKTOP_GUIDE.md` — Desktop vs cloud job routing, three sync lanes, Turso pull on wake

## Skills (loaded on demand)

Use `read_skill` to load full skill content when needed. Key skills include:
- **Liquid Glass Design System** — Design language for mini-apps
- **Document System** — Creating and managing Papr documents
- **PPTX / DOCX / XLSX** — Office document creation
- **GitHub Integration** — PRs, issues, CI via `gh` CLI
- **Social Media / Platform Connections** — `read_skill({ skillId: "preloaded-social-media-auth" })`
- **Content Strategy / Copywriting / SEO** — Marketing skills

See `search_agent_memory` with category "agent_skill" for contextual skill discovery.
