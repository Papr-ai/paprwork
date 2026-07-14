# Example App Architecture Plan

**Purpose:** Copy this structure when Product Architect (or the main agent) plans a mini-app + jobs system.  
**Audience:** Agents — read alongside `PRODUCT_ARCHITECT_GUIDE.md` before `create_plan` / `create_app` / `create_job`.

---

## When to use this doc

```javascript
read_file({ path: "src/resources/agent-docs/EXAMPLE_APP_ARCHITECTURE_PLAN.md" })
```

Use when building anything with **frontend + backend handlers + SQLite + jobs**.  
`create_plan` tracks **execution steps**; this doc tracks **system design** (layers, schema, data flow).

---

## Worked example: Blog Topic Planner

User goal: *Pull Reddit RSS feeds, pick topics with an agent, enrich with web research, draft blog posts — all visible in one dashboard.*

### 1. Product Brief

| Field | Value |
|-------|--------|
| **Job to be done** | Consultant opens one dashboard, sees fresh topic picks, enriches a pick, generates a draft — without manual copy-paste between tools. |
| **Scope (in)** | RSS ingest, topic picker agent, enricher agent, writer agent, settings (feeds + site URL), planner UI. |
| **Scope (out)** | WordPress publish, multi-user auth, billing. |
| **Success criteria** | User adds RSS URL → within one schedule cycle sees rows in UI → clicks Enrich → sees enrichment → clicks Write → sees draft text. |

### 2. Paprwork Architecture

#### 2.1 Layer split (three-layer runtime)

```
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 1 — Frontend (apps/{appId}/)                              │
│   index.html, app.ts, views/*.ts                               │
│   Calls: /api/db/query|write|exec, /api/jobs/run,              │
│          /api/app/backend/:action, subscribeJobEvents          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│ LAYER 2 — App backend (apps/{appId}/backend/)                    │
│   manifest.json → settings-save, migrate (schema bootstrap)    │
│   Vault keys server-side only; NO /api/bash/run from iframe    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│ LAYER 3 — Jobs (~/Papr/Jobs/{jobId}/)                          │
│   python: RSS fetch, persist rows                                │
│   agent: picker, enricher, writer                                │
│   All linked via create_job({ appIds: [appId] })                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│ DATA — Primary SQLite (one file, APP_DB)                         │
│   ~/Papr/Jobs/{primaryJobId}/data/data.db                        │
│   Linked in data-sources.json as primary                         │
│   App reads/writes via /api/db/*; jobs write via $APP_DB         │
└─────────────────────────────────────────────────────────────────┘
```

#### 2.2 Mini-apps (prefer focused apps)

| App | Mode | Screens |
|-----|------|---------|
| **Blog Topic Planner** | Delivery / read-write | Feed list, topic picks table, enrichment panel, draft viewer, settings |

*Anti-pattern avoided:* One 40-file monolith with every view on one scroll — use 2–3 sections max per screen.

#### 2.3 Jobs

| Job name | Type | Schedule | appIds | dependsOn | Writes to |
|----------|------|----------|--------|-----------|-----------|
| Reddit RSS Fetcher | `python` | every 30m | `[appId]` | — | `$APP_DB`: `blog_posts_raw` |
| Topic Picker | `agent` | after fetch | `[appId]` | fetch → `autoTrigger: true` | `$APP_DB`: `blog_picks` |
| Persist Picks | `python` | — (on-demand or chained) | `[appId]` | picker | `$APP_DB`: `blog_picks` |
| Topic Enricher | `agent` | on-demand (`/api/jobs/run`) | `[appId]` | — | `$APP_DB`: `blog_picks.enriched_*` |
| Blog Writer | `agent` | on-demand | `[appId]` | — | `$APP_DB`: `blog_drafts` |

**Rules applied:**
- LLM reasoning → `type: "agent"` (not python calling OpenAI manually)
- ETL / RSS parse → `type: "python"`
- Every job: `appIds: [appId]` from `list_apps()` — auto-links primary DB
- UI tables → **`$APP_DB`**; scratch (`job_runs`) → **`$JOB_DB`**
- Pipeline edges: `dependsOn: [{ jobId, onStatus: "completed", autoTrigger: true }]`

#### 2.4 Shared SQLite schema (primary / APP_DB)

Bootstrap via `POST /api/db/exec` or `backend/migrate` action **registered in manifest.json**.

```sql
-- Settings (app + jobs read)
CREATE TABLE IF NOT EXISTS user_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Raw ingest (RSS job writes)
CREATE TABLE IF NOT EXISTS blog_posts_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT,
  title TEXT,
  link TEXT UNIQUE,
  fetched_at TEXT
);

-- Picks (picker + enricher)
CREATE TABLE IF NOT EXISTS blog_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_id INTEGER,
  title TEXT,
  score REAL,
  status TEXT DEFAULT 'pending',  -- pending | enriched | drafted
  enriched_summary TEXT,
  enriched_at TEXT,
  created_at TEXT
);

-- Drafts (writer job)
CREATE TABLE IF NOT EXISTS blog_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pick_id INTEGER UNIQUE,
  body TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_picks_status ON blog_picks(status);
```

Optional: `data-contract.json` with `enforceOnFailure: true` after Phase 1 proves stable.

#### 2.5 Data flow

```
RSS URLs (user_settings)
    → [python: RSS Fetcher] → blog_posts_raw
    → [agent: Topic Picker] → blog_picks (status=pending)
    → UI: user clicks row
    → [agent: Enricher] via /api/jobs/run → blog_picks.enriched_*
    → UI: user clicks Write
    → [agent: Writer] → blog_drafts
    → UI: /api/db/query SELECT draft
```

**Frontend refresh:** `subscribeJobEvents({ jobIds, onDbChanged: () => loadData() })` — never poll `/api/jobs/status`.

#### 2.6 API endpoint map (frontend)

| Operation | Endpoint | Notes |
|-----------|----------|-------|
| Read picks | `POST /api/db/query` | SELECT only |
| Save settings | `POST /api/db/write` | NOT `/api/db/query` — gateway returns 403 |
| Bootstrap schema | `POST /api/db/exec` or `/api/app/backend/migrate` | migrate.py **must** be in manifest |
| Run enricher | `POST /api/jobs/run` | `{ jobId }` |
| Load schema | `GET /api/db/schema?appId=` | Call before assuming tables exist |

### 3. Design System (Liquid Glass)

| Screen | Sections (max 3) | Primary action |
|--------|------------------|----------------|
| Planner home | Stats strip, picks table, detail drawer | **Enrich selected pick** |
| Settings | Feed URLs, site name | **Save settings** |

Anti-patterns to avoid: 6 metric cards + 3 tables on one page; multiple blue primary buttons.

### 4. Phased Plan

**Phase 1 (MVP — ship this first)**
1. Schema bootstrap + settings save (backend migrate + `/api/db/write`)
2. RSS python job + `blog_posts_raw` rows visible in UI
3. Picker agent job + picks table
4. Manual enrich via button (one agent job)

**Phase 2**
- Writer agent + drafts panel
- Scheduled fetch + auto picker chain
- `data-contract.json` enforcement

**Phase 3**
- Cloud publish + Turso sync verification
- Per-user isolation if needed

### 5. Risks & Open Questions

| Risk | Mitigation |
|------|------------|
| Agent uses `/api/db/query` for UPDATE | `validate_app` rule `db-query-write-forbidden` |
| `migrate.py` not in manifest | `validate_app` rule `backend-handler-orphan` |
| Agent writes UI tables to `$JOB_DB` | Tool reminder `_appDbJobReminder` on create_job |
| Tables missing on primary DB | `validate_app` rule `db-table-missing-on-primary` |
| Agent skips architecture | Delegate to `product-architect` before build |

**Open:** Which RSS feeds default? Which model for picker vs writer?

### 6. Recommendation

**Proceed with Phase 1** — one app, four jobs max, single primary DB. Defer writer until enrich path works end-to-end.

---

## Blank template (copy for new projects)

```markdown
## 1. Product Brief
- Job to be done:
- Scope in / out:
- Success criteria:

## 2. Paprwork Architecture
### Layers
- Frontend (apps/{id}/): screens, /api/db/*, /api/jobs/run, subscribeJobEvents
- Backend (backend/manifest.json): actions, vault keys
- Jobs (~/Papr/Jobs/): types, schedules, appIds, dependsOn+autoTrigger
### SQLite (APP_DB primary)
| Table | Columns | Writer | Reader |
### Data flow (ASCII)
### Job table
| Name | Type | Schedule | appIds | dependsOn |

## 3. Design System
- Screens (2-3 sections each), ONE primary action per screen

## 4. Phased Plan
- Phase 1 MVP:
- Phase 2+:

## 5. Risks & Open Questions

## 6. Recommendation (proceed / simplify / defer)
```

---

## Order of operations (agents)

```
1. list_apps() + list_jobs()
2. delegate_task({ useAgentId: "product-architect", ... })  ← architecture doc
3. User approves Phase 1
4. create_plan({ steps from Phase 1 })                      ← UI progress card
5. create_app / create_job / build
6. validate_app after each major edit
```

**Do not** swap steps 2 and 4 on complex work — architecture before execution plan.
