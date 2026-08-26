> **Paths:** `$PAPR_HOME` = active org/namespace workspace (`~/Papr/orgs/{orgId}/namespaces/{nsId}/`). See `docs/PAPR_WORKSPACE_PATHS.md`. Prefer app/job tools over raw paths.

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
│   ACL: PAPR_CALLER_USER_ID / PAPR_CALLER_EMAIL when signed in  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│ LAYER 3 — Jobs ($PAPR_HOME/Jobs/{jobId}/)                          │
│   python: RSS fetch, persist rows                                │
│   agent: picker, enricher, writer                                │
│   All linked via create_job({ appIds: [appId] })                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│ DATA — Primary SQLite (one file, APP_DB)                         │
│   $PAPR_HOME/Jobs/{primaryJobId}/data/data.db                        │
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
| Topic Enricher | `agent` | on-demand (`/api/jobs/run`) | `[appId]` | — | `$APP_DB`: `blog_picks.enriched_*` |
| Blog Writer | `agent` | on-demand | `[appId]` | — | `$APP_DB`: `blog_drafts` |

The producing job owns its validated final write. Do not add a separate persistence job unless it represents a real deterministic transformation, transaction, or approval boundary.

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

## Anti-pattern: Frontend SQL soup (DO NOT BUILD THIS)

When an agent skips the backend layer, you get a `db.ts` file with 10+ raw SQL wrapper functions all running from the browser. This is the **#1 mini-app architecture mistake**.

**BAD — all SQL in frontend `db.ts`:**
```typescript
// db.ts — 15 functions doing fetch('/api/db/query') with raw SQL
export async function getStudents(classId: number) {
  const r = await fetch('/api/db/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT * FROM students WHERE class_id = ?', params: [classId] })
  });
  return (await r.json()).rows;
}
export async function updateStudent(id: number, name: string, level: string) { /* ... */ }
export async function getReports(classId: number, termId: number) { /* ... */ }
// ... 12 more functions like this — all raw SQL in the browser
```

**Problems:** SQL logic exposed in browser, no server-side validation, no transaction support, impossible to add vault keys later, `validate_app` flags `suggest-backend-handlers` warning. For multi-user apps, raw `/api/db/query` also lets any signed-in user read all rows — no row ACL.

**GOOD — backend handler + thin frontend:**
```python
# backend/students.py — server-side handler registered in manifest.json
import json, os, sys, sqlite3

def main():
    params = json.loads(os.environ.get("PAPR_ACTION_PARAMS", "{}"))
    user_id = os.environ.get("PAPR_CALLER_USER_ID")  # server-injected; never params["userId"]
    if not user_id:
        sys.exit("Sign in required")
    db_path = os.environ.get("APP_DB")
    conn = sqlite3.connect(db_path)
    action = params.get("action", "list")
    if action == "list":
        rows = conn.execute("SELECT * FROM students WHERE class_id = ?",
                            [params["classId"]]).fetchall()
        json.dump({"rows": rows}, sys.stdout)
    elif action == "update":
        conn.execute("UPDATE students SET name=?, level=? WHERE id=?",
                     [params["name"], params["level"], params["id"]])
        conn.commit()
        json.dump({"ok": True}, sys.stdout)

if __name__ == "__main__":
    main()
```

```typescript
// Frontend: one clean call per resource — do NOT pass userId in params for ACL
const res = await fetch('/api/app/backend/students', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId: APP_ID, params: { action: 'list', classId: '1' } }),
});
```

**Detection:** `validate_app` counts `/api/db/query` and `/api/db/write` calls across frontend `.ts` files. If count > 4 with no `backend/` directory → warning. If count > 8 → error. Also flags frontend code with auth headers (`Authorization`, `x-api-key`) calling external APIs — those MUST go through backend handlers.

---

## Anti-pattern: External API calls from frontend (DO NOT BUILD THIS)

Backend handlers are NOT just for SQL. Any external API call that requires a secret key MUST go through a backend handler — never from browser `fetch()`.

**BAD — API key exposed in frontend:**
```typescript
// app.ts — calling external API directly from browser
const res = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer sk-...',  // SECRET KEY IN BROWSER CODE!
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ model: 'gpt-4', messages: [...] })
});
```

**Problems:** API key visible in browser DevTools, can be stolen by any user, impossible to rotate without redeploying frontend, violates every security best practice.

**GOOD — backend handler proxies the call:**
```json
// backend/manifest.json
{
  "version": 1,
  "actions": {
    "generate-summary": {
      "handler": "generate_summary.py",
      "runtime": "python",
      "description": "Call OpenAI to generate a summary",
      "keys": ["OPENAI_API_KEY"],
      "timeoutMs": 30000
    }
  }
}
```

```python
# backend/generate_summary.py — server-side, key injected as env var
import json, os, sys, urllib.request

def main():
    params = json.loads(os.environ.get("PAPR_ACTION_PARAMS", "{}"))
    api_key = os.environ["OPENAI_API_KEY"]  # Injected from vault — never in browser
    
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps({
            "model": "gpt-4",
            "messages": [{"role": "user", "content": params.get("prompt", "")}]
        }).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
    json.dump({"summary": result["choices"][0]["message"]["content"]}, sys.stdout)

if __name__ == "__main__":
    main()
```

```typescript
// Frontend: clean call, no secrets
const res = await fetch('/api/app/backend/generate-summary', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'Summarize this article...' })
});
const { summary } = await res.json();
```

**Rule:** If your app needs API keys, OAuth tokens, or any secrets → backend handler. No exceptions.

---

## Multi-user / role-scoped apps (backend ACL pattern)

Use when different signed-in users see different rows (manager vs IC, roster claim, passcode onboarding).

| Layer | Responsibility |
|-------|----------------|
| **Publish** | `link_read_write` or `team` + sign-in — who can open the app |
| **Schema** | `papr_user_id TEXT` on roster/entity rows — who owns each row |
| **Backend** | Read **`PAPR_CALLER_USER_ID`** from env; lookup role; return scoped rows |
| **Frontend** | Call `/api/app/backend/:action` — never pass `userId` in `params` for auth |

```python
# backend/get-team-scores.py
user_id = os.environ.get("PAPR_CALLER_USER_ID")
if not user_id:
    sys.exit("Sign in required")
row = conn.execute("SELECT role FROM roster WHERE papr_user_id = ?", [user_id]).fetchone()
if row[0] not in ("manager", "leader"):
    sys.exit("Forbidden")
# return rows scoped to this manager's team
```

**Do not:** rely on `GET /api/access` + client-side `WHERE papr_user_id = ?` via `/api/db/query` for sensitive data — any user can drop the filter in DevTools.

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
- Backend (backend/manifest.json): actions, vault keys, caller-identity needs — list each action OR explicitly justify skipping ("read-only dashboard, 1-2 SELECTs only")
- Multi-user? If yes: roster table + `papr_user_id`, backend actions using `PAPR_CALLER_USER_ID`, publish mode (`link_read_write` / `team`)
- Jobs ($PAPR_HOME/Jobs/): types, schedules, appIds, dependsOn+autoTrigger
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
