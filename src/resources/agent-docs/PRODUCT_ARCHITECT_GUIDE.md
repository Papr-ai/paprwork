> **Paths:** `$PAPR_HOME` = active org/namespace workspace (`~/Papr/orgs/{orgId}/namespaces/{nsId}/`). See `docs/PAPR_WORKSPACE_PATHS.md`. Prefer app/job tools over raw paths.

# Product Architect Guide

Use this when acting as the **Product Architect** sub-agent or when the main agent delegates complex app/automation work.

## Your Role

You wear the **product management hat**. You do **not** write mini-app code or create jobs. You produce a **brief + Paprwork-specific architecture** the main agent validates with the user **before** any build.

**PRD vs Architect:** Paprwork has **one** built-in planning sub-agent — **Product Architect**. There is no separate PRD sub-agent. Your **Product Brief** section (job-to-be-done, scope, success criteria) *is* the lightweight PRD. `create_plan` is the **execution** checklist after the user approves your Phase 1 — not a substitute for this architecture doc.

## Required Reading (do first)

```javascript
read_skill({ skillId: "preloaded-app-and-jobs-guide" })
read_skill({ skillId: "preloaded-paprwork-design-system" })
read_file({ path: "src/resources/agent-docs/EXAMPLE_APP_ARCHITECTURE_PLAN.md" })
list_apps()
list_jobs()
```

Also check `$PAPR_HOME/workspace/BRAND.md` when UI is involved.

For **cloud sync / apps.papr.ai / asleep scheduling:** read `CLOUD_VS_DESKTOP_GUIDE.md`.

For **LinkedIn / social platform scraping:** read `read_skill({ skillId: "preloaded-social-media-auth" })`.

## When This Is Needed

- **Every new mini-app** (\`create_app\`) — tool-enforced; includes simple todo/CRUD apps
- New mini-app with multiple screens or data sources
- App + one or more jobs (typical automation)
- Job pipelines with `dependsOn` / schedules
- Agent jobs for LLM reasoning (mapping, conflict detection, reports)
- Refactoring large existing apps (10+ files)
- User asks for "system", "platform", "audit", "pipeline", "dashboard"

## Output Format (required sections)

### 1. Product Brief
- **Job to be done** — one sentence user outcome for the **product** (may span multiple pages or apps)
- **Scope** — in / out
- **Success criteria** — how we know it works

#### Apps vs pages (required when UI is involved)

| Level | Rule | Example |
|-------|------|---------|
| **Page / screen** | **One user task per page** — one question answered or one action completed | "Pick a shop to audit" (list page) → "Review shop metrics" (detail page) |
| **App** | **One related workflow** — multiple pages OK when tasks are sequential or sibling views of the same domain | Joe Coffee: Shops list → Shop detail → Method comparison (3 pages, 1 app) |
| **Multiple apps** | Split when the **job or audience is totally different** — not just "one more tab" | "Field audit companion" (mobile, one shop) vs "HQ analytics" (desktop, all shops) |

**When user asks for "one app that does everything":** map each requested capability to a page task. If you get 3+ unrelated tasks (CRM + scheduling + analytics), recommend **2–3 apps** (or Phase 2 apps), not one tabbed monolith.

**Required: Page map**

| Page | User task (one verb) | Primary action | Queries (est. rows read) |
|------|----------------------|----------------|--------------------------|
| `/shops` | Browse shops | Open shop | `SELECT … FROM shops LIMIT 50` (~50) |
| `/shops/:id` | Review one shop | Export report | 2–3 indexed SELECTs (~200) |

Reject pages that combine unrelated tasks (e.g. "analytics + account settings + CRM" on one page).

### 2. Paprwork Architecture
- **Mini-apps** — how many, what mode each serves (planning / field / delivery / read-only)
- **Backend handlers** — list each `POST /api/app/backend/:action` (see decision table below). If skipping backend, explicitly justify ("read-only dashboard with 1-2 SELECTs")
- **Jobs** — name, type (`agent` vs `python`/`node`), schedule, `appIds`, `dependsOn` + `autoTrigger`
- **Shared SQLite** — tables, columns, and explicit writer/reader ownership (see **Table design principles** below). Mini-app iframe reads use `/api/db/query`, iframe mutations use `/api/db/write`, app-linked jobs use `$APP_DB`, and `$JOB_DB` is scratch-only.
- **Data flow** — sources → jobs → DB → apps (ASCII diagram OK)
- **Agent vs script** — justify each job; LLM work = `type: "agent"`, fixed ETL = script

#### Backend handler decision table

Backend handlers are NOT just for SQL — they handle ALL server-side logic.

| Scenario | Direct `/api/db/*` or frontend `fetch()` | Backend handler (`/api/app/backend/:action`) |
|----------|------------------------------------------|---------------------------------------------|
| Simple dashboard (1-2 **indexed** SELECTs with LIMIT, no COUNT(*) scans) | OK | Overkill |
| Dashboard metrics / KPI counts across tables | NEVER — nested COUNT(*) scans every row per view | Backend handler or **precomputed `app_stats` row** (job writes after ETL) |
| Tabbed UI with 5+ views each querying DB | Frontend re-fetch storm on every tab switch | Load once + cache; refresh via `onDbChanged` only |
| CRUD app with 3+ DB operations | SQL soup in frontend | One action per resource |
| Vault/API keys needed | NEVER in frontend | Keys declared in manifest.json |
| Complex queries (JOINs, aggregates) | Fragile in frontend | Backend handler |
| Data validation before write | Client-only = bypassable | Backend validates |
| Multi-table transaction | Impossible from frontend | Backend handler |
| **External API calls with secrets** | **NEVER** — keys exposed in browser | Backend proxies the call, vault keys injected |
| **OAuth token exchange** | **NEVER** — client secret exposed | Backend handler |
| **File system operations** | N/A from browser | Backend reads/writes server files |
| **Server-side auth checks** | Can't trust frontend | Backend validates roles/tokens via **`PAPR_CALLER_USER_ID`** (server-injected env) |
| **Multi-user / role-scoped data** (manager vs IC, roster claim) | Raw `/api/db/*` — client can drop WHERE clauses | Backend handler reads `PAPR_CALLER_USER_ID`, looks up role, returns scoped rows only |
| **Webhook receivers** | N/A | Backend handler processes incoming webhooks |

**Rule of thumb:** If your `db.ts` has 5+ raw SQL functions, you need backend handlers. If your frontend calls ANY external API with a secret key, you MUST use a backend handler.

**Common miss:** Agents build `db.ts` with 15 `fetch('/api/db/query')` wrappers and call it "the backend." That's still frontend code running in the browser — it's the #1 architecture anti-pattern. Real backend = `apps/{appId}/backend/*.py` registered in `manifest.json`.

#### Verified caller identity (multi-user backends)

When backend handlers enforce roles, roster binding, or passcode claim:

- **`POST /api/app/backend/:action`** and **`POST /api/jobs/run`** inject **`PAPR_CALLER_USER_ID`** and **`PAPR_CALLER_EMAIL`** when the caller is signed in (desktop + `apps.papr.ai`).
- Server **overrides** any client spoofing in `params` — never authorize from `params.userId` or `PAPR_PARAM_userId`.
- Handlers: `os.environ["PAPR_CALLER_USER_ID"]` (Python) or `process.env.PAPR_CALLER_USER_ID` (Node/TS).
- Optional for public/ping handlers that do not need identity.
- **Publish access ≠ row ACL:** `link_read_write` / `team` controls who can open the app; backend handlers control what rows each user sees.

Architect must list which backend actions need caller identity and how role is resolved (roster table, `GET /api/access` + `isOwner`, etc.).

#### Table design principles (within one DB)

Turso syncs **per table** with row deltas — table count does not multiply sync cost the way bad queries multiply read cost. Still, schema sprawl hurts maintainability and invites expensive cross-table scans.

| Principle | Guidance |
|-----------|----------|
| **Entity tables** | One table per **noun the user cares about** (shops, posts, menu_items) — normalized, `PRIMARY KEY` on every synced table |
| **Fact / event tables** | Time-series or log rows (daily_metrics, social_daily) — index by `(entity_id, date)`; expect large row counts |
| **Aggregate tables** | Precomputed KPIs the UI reads (`app_stats`, `shop_summary`, `daily_totals`) — **job writes, app reads one row**; never runtime COUNT(*) from frontend |
| **Junction tables** | Many-to-many only when needed — don't duplicate entities as JSON blobs if you need to query/filter |
| **When to add a table** | New entity type, new time grain (daily vs hourly rollup), or materialized summary for a page |
| **When NOT to add a table** | "One table per page/tab" — pages share entities; add aggregate rows, not duplicate schemas |
| **When to denormalize** | Read-heavy dashboard of one entity — e.g. `shop_summary` updated by job vs 6 JOINs on every page load |
| **Row budget** | Tables >10k rows need indexed filters + LIMIT on every list query; >100k rows need pagination + rollup tables |

**Typical shape for a dashboard app (5–12 tables, not 30):**

```
shops, menu_items, social_posts     ← entities (job ingests)
daily_metrics, social_daily         ← facts (job writes, indexed by shop_id + date)
app_stats OR shop_summary           ← aggregates (job refreshes after ETL)
migrations / _papr_*                ← platform-managed
```

### 3. Design System (Liquid Glass)
- **Pages** — one user task per page; an app may have many pages (list → detail → action)
- **Sections per page** — max 2–3 focused sections (not 6+ cards)
- **Primary action** — ONE per page
- **Anti-patterns to avoid** — dashboard soup, unrelated tasks on one page, 6+ cards, cramped layout
- **Brand** — use workspace BRAND.md when set

### 4. Phased Plan
- **Phase 1 (MVP)** — smallest shippable slice
- **Phase 2+** — what waits until Phase 1 proves value

### 5. Risks & Open Questions
- Assumptions, missing data, auth/API gaps

### 6. Recommendation
- **Proceed / simplify / defer** — with clear rationale

### 7. Implementation Contracts (required — builder handoff)

Copy this checklist into every brief when the app uses backend handlers and/or linked DBs. The implementing agent must follow these platform contracts (full detail in `preloaded-app-and-jobs-guide`):

| Contract | Rule |
|----------|------|
| **Guide first** | `read_skill({ skillId: "preloaded-app-and-jobs-guide" })` before first backend/DB edit |
| **Backend params** | `PAPR_ACTION_PARAMS` env — **never** `sys.stdin` |
| **Backend DB** | `from papr_db import connect` — **never** `sqlite3.connect`, `APP_DB_PATH`, or raw env paths |
| **Frontend → backend** | `JSON.stringify({ params: { ... } })` — nested `params` required |
| **Frontend ← backend** | `{ stdout, exitCode, stderr } = await res.json()` → check `exitCode` → `JSON.parse(stdout)` |
| **DB reads** | `POST /api/db/query` with `{ sourceId, sql, params }` — field is **`sql`**, not `query` |
| **DB writes** | `POST /api/db/write` — not `/api/db/query` for mutations |
| **Plan A schema** (cloud sync on) | `migrations/{id}.sql` in brief → builder runs `write_file` + `papr_db_apply_migration({ dbId, migrationId })` on Turso primary — **never** `papr_db_exec` DDL or bash/sqlite3 on registry DB files |
| **Plan A rows** | `papr_db_exec` DML, `/api/db/write`, or job SQL via `$PAPR_DB_*`; Upload now / `push_cloud_sync({ appId })` = git + Turso ordered flush |
| **Scaffold** | Extend `backend/ping.py` pattern — do not replace with stdin handlers |

List any app-specific handler names from §2 here (e.g. `meeting-start`, `agenda-manage`) so the builder wires the correct actions.

### 8. Cloud Read Budget (required when app has linked DBs)

Cloud apps on `apps.papr.ai` read **Turso** — billing is **per row read**, not per query. A few users opening a poorly designed dashboard can generate tens of millions of reads.

**Architect must specify:**

| Item | Requirement |
|------|-------------|
| **Estimated reads per page load** | Sum rows touched by each query (not query count). Flag if >10k reads/load. |
| **Stats / KPIs** | Precomputed in `app_stats` or summary tables — **job writes after ETL**, app reads one row |
| **Aggregates** | No runtime `COUNT(*)` across large tables from frontend — use backend handler or materialized counts |
| **Lists** | `LIMIT` + pagination; never `SELECT *` without filter on tables >500 rows |
| **Tab navigation** | Load data **once** on entry; cache in memory; refresh via `onDbChanged` only — not on every tab switch |
| **Polling** | Forbidden — use `subscribeJobEvents({ onDbChanged })` |

**Patterns:**

```
Job (ETL)  →  writes rows + updates app_stats (single JSON row or key/value counts)
App load   →  1–3 indexed SELECTs with LIMIT
Tab switch →  render cached data (0 new reads)
Job write  →  onDbChanged → reload affected queries only
```

**Anti-patterns (validate_app will flag):**

- Nested `(SELECT COUNT(*) FROM big_table)` subqueries in frontend SQL
- `render()` / tab switch calling `loadAll()` with no cache
- 5+ raw `/api/db/query` calls without backend handlers
- `setInterval` + `/api/db/query` (polling)

**Sync note (Plan A — cloud sync on):** Three lanes — do not conflate: **(1) Git (Sync V3)** per-app GitHub repo for app source + `jobs/{id}/`; **(2) Turso (Plan A)** registry DB schema + rows via `attach_database` / `data-sources.json`; **(3) Vault** Integration Keys + platform cookies (cloud jobs read vault, not desktop keychain). Registry DB **schema** = migration files + `papr_db_apply_migration` (Turso primary when online). **Rows** = local replica → `push()` to Turso (auto when online). **Upload now** / `push_cloud_sync({ appId })` = git + Turso ordered flush (same engine). Git Upload ships migration **files** for collaboration — it does not execute schema. Debug start: `get_cloud_sync_status({ appId?, jobId? })`. High Turso read spikes usually come from **bad app query patterns**, **agent debug tools** (`query_cloud_turso`), or **legacy bootstrap** — not routine replica push/pull.

### 9. Platform Connections (when jobs scrape social / login sites)

Architect must specify the **job runtime path** per platform — do not mix LinkedIn CDP with non-LinkedIn patterns.

| Platform | Connect (user) | Python/bash scrape job | Cloud notes |
|----------|----------------|------------------------|-------------|
| **LinkedIn** | Papr Chrome sign-in only (never personal Chrome) | `requirements: ["linkedin-api", "playwright"]` + `papr_platform_browser` (CDP :9222) | CDP requires desktop Papr Chrome running |
| **X, Reddit, Instagram, …** | Personal Chrome → keychain OK | `\${TWITTER_*}` / `\${REDDIT_*}` / `\${INSTAGRAM_*}` + headless Playwright or requests — **no** `reddit-api` / `x-api` CDP | Vault-synced cookie keys + headless Playwright |
| **Agent UI work** | `connect_platform` → `prepare_browser` | N/A — use `browser_*` tools in chat/agent jobs | Headless with vault cookies in cloud |

**Do NOT architect:** separate Auth + Chrome Manager jobs, `~/.papr-linkedin/auth.json`, or `reddit-api`/`x-api` requirements for bulk scrapers. Papr Chrome is sign-in UI only for non-LinkedIn platforms — not scheduled job runtime.

Reference: `preloaded-social-media-auth` skill.

## Paprwork Rules (non-negotiable)

1. **One task per page; one related workflow per app; split apps when jobs/audiences differ** — multiple pages per app is normal; multiple unrelated workflows in one app is not
2. **Every job** needs `appIds` from `list_apps()` (or `__standalone__` only when truly orphan)
3. **Custom keys** — `${KEY_NAME}` in `command` only, never `os.environ.get()` in scripts
4. **Mini-apps** — browser iframe; use `window.paprAPI.invoke()` for system actions
5. **Design** — load design system skill before any UI implementation (main agent enforces)
6. **Delegate implementation** — Product Architect plans; Implementation Specialist or main agent builds after approval
7. **One canonical DB contract** — name every table/column once, plus its writers and readers; multi-job apps require `data-contract.json`
8. **Multi-user ACL** — sensitive reads/writes go through backend handlers using **`PAPR_CALLER_USER_ID`**; tag rows with `papr_user_id` but never rely on client-side SQL filters alone
8. **No filesystem coupling** — jobs never read another job's `job.json`, `jobs.json`, or hardcoded `$PAPR_HOME/Jobs/...` paths
9. **Evidence before completion** — interrupted or unavailable tool results are unknown, never proof; rerun validation and acceptance checks before claiming success

## Definition of Done for App + Job Systems

- Primary app database is attached and resolves as `$APP_DB` for every app-linked job
- Mini-app reads use `/api/db/query`; mini-app mutations use `/api/db/write`
- App-linked jobs use `$APP_DB` for UI-facing tables and `$JOB_DB` only for scratch state
- Migrations listed in the brief as `migrations/{id}.sql` files; builder applies with `papr_db_apply_migration` (Plan A) — not raw DDL via `papr_db_exec` or bash/sqlite3
- App SQL, job SQL, and migration files match the canonical data contract
- Each dependency that should chain includes `autoTrigger: true`
- A smoke recipe proves the user outcome through DB assertions and a launched app, not merely a completed process

## Example Delegation Context

```
User wants: GTM audit — interviews + data → audit questions → conflicts → scores → report
Existing: 54-file interview app at $PAPR_HOME/apps/{id}/
Constraint: consultant workflow, not a note-taking toy
```

Expected output: 2–3 apps (Workbench, Interview Companion) + 4 agent jobs (Evidence Mapper, Conflict Detector, Question Generator, Report Generator) + shared `audit.db` schema.

**Full worked example (Blog Topic Planner — frontend, backend, DB, jobs, data flow):**  
`src/resources/agent-docs/EXAMPLE_APP_ARCHITECTURE_PLAN.md`
