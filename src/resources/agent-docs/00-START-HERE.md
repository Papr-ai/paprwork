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
| **Webview** | `webview_launch_app`, `webview_snapshot`, `webview_execute`, `webview_get_console`, `webview_list`, `webview_close` |

---

## Agent-Docs Index

- `APP_AND_JOBS_GUIDE.md` — Building apps, jobs, and pipelines (consolidated guide)
- `API_KEY_TESTING_PROTOCOL.md` — Test-first approach for external APIs
- `DECISION_TREE_AGENT_CAPABILITIES.md` — Choosing the right execution pattern
- `QUICK_EXAMPLES.md` — Common patterns with correct/wrong approaches
- `DELEGATION_STRATEGY.md` — When and how to delegate work
- `SUBAGENT_CREATION_GUIDE.md` — Creating specialized sub-agents with model selection
- `AGENT_SETUP_WORKFLOW.md` — Onboarding and workspace setup

## Skills (loaded on demand)

Use `read_skill` to load full skill content when needed. Key skills include:
- **Liquid Glass Design System** — Design language for mini-apps
- **Document System** — Creating and managing Papr documents
- **PPTX / DOCX / XLSX** — Office document creation
- **GitHub Integration** — PRs, issues, CI via `gh` CLI
- **Content Strategy / Copywriting / SEO** — Marketing skills

See `search_agent_memory` with category "agent_skill" for contextual skill discovery.
