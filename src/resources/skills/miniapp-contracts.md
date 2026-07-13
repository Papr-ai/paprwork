---
id: preloaded-miniapp-contracts
name: Mini-App Data Contracts
description: Define app/job data contracts before implementing UI — specify datasets, refresh behavior, and fallback states.
---
# Mini-App Data Contracts

Define the contract between jobs (data producers) and apps (data consumers) before implementing either side.

## Why Contracts Matter

Without a contract:
- Job writes columns the app doesn't expect
- App queries tables that don't exist yet
- Schema changes break the UI silently
- No clear ownership of data shape

With a contract:
- Both sides agree on table names, columns, types
- Indexes match query patterns
- Fallback behavior is explicit
- Changes are versioned

## Contract Template

```
## Data Contract: [App Name] <-> [Job Name]

### Write Model (what the job produces)
- Database: ~/Papr/jobs/{jobId}/data.db
- Tables:
  - `table_name`: columns, types, constraints
- Indexes: which columns, matching which queries
- Write frequency: how often data is updated
- Retention: how long data is kept

### Read Model (what the app queries)
- Queries: exact SQL the app will run
- Refresh: on app load + **push events** via `subscribeJobEvents()` (`/api/jobs/events` SSE)
- Use `onDbChanged` to auto-refresh when any write path changes the DB (job, agent, Turso pull)
- Use `onStatusChanged` to react to job lifecycle (completed, failed, running)
- **Never** poll `/api/db/query` on an interval — cloud apps bill Turso per row read
- **Batch page-load queries**: if the app fires 2+ queries on mount, use one `POST /api/db/batch` with `{ appId, statements: [{ sql, params?, sourceId? }, ...] }` (max 25) → `{ results: [{ ok, rows, ... }] }`. One round trip instead of N — works local and cloud.
- Jobs emit live progress: `PAPR_PROGRESS {"event":"...","payload":{...}}` on stdout
- Fallback: manual refresh button only

### Schema Migrations
- Version tracking via `schema_migrations` table
- Backward-compatible changes only
```

## Example Contract

```
## Data Contract: Funnel Dashboard <-> Amplitude Sync

### Write Model
- Table: funnel_runs
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - date TEXT NOT NULL
  - prelogin_visitors INTEGER
  - logins INTEGER
  - conversion_rate REAL
  - created_at TEXT DEFAULT (datetime('now'))
- Index: idx_funnel_date ON funnel_runs(date)
- Write frequency: Every 6 hours
- Retention: 90 days

### Read Model
- Today's metrics: SELECT * FROM funnel_runs WHERE date = date('now')
- 7-day trend: SELECT * FROM funnel_runs ORDER BY date DESC LIMIT 7
- Refresh: On app load + manual refresh button
- Fallback: Show "No data yet - run sync job" with action button

### Schema Migrations
- v1: Initial schema (funnel_runs + index)
- v2: Added conversion_rate column (nullable for backcompat)
```

## Linking Apps to Data (required for cloud DB)

**Job-owned (default):** `create_job({ appIds: [appId], ... })` **auto-links** the job's `data.db` and writes `data-sources.json` (synced to git). Cloud `/api/db/*` requires this file — auto-link satisfies it for the common path.

**Manual fallback** (re-link, standalone `dbId`, or auto-link failed):

```javascript
link_app_data_source({
  appId: "funnel-dashboard",
  jobId: "amplitude-sync",  // OR dbId for registry DB
  alias: "funnel",
  setPrimary: true,
  tables: ["funnel_runs"]
})
```

Call linking **before** implementing `/api/db/query` or `/api/db/write` if `read_app_data_sources` shows no sources. Linked databases sync to Turso automatically after cloud sync is enabled.

## Cloud hosting (automatic — ready)

When cloud sync is enabled (default):

1. App source syncs to GitHub and auto-publishes to `apps.papr.ai` (private by default)
2. Linked job databases (via `data-sources.json` — auto-created by `create_job({ appIds })` or manual link) sync to Turso
3. App code using relative `/api/db/*` works **unchanged** on the cloud URL

**No extra deploy steps** — do not add Vercel/Netlify publish, Turso credentials, or cloud URL wiring to plans.

| Works on cloud | Desktop-only |
|----------------|--------------|
| `/api/db/schema`, `/api/db/query`, `/api/db/batch`, `/api/db/write`, `/api/db/exec` | `window.paprAPI` (chat.open, shell, etc.) |
| `/api/jobs/list`, `/api/jobs/status`, `/api/jobs/run`, `/api/jobs/events` (SSE) | `/api/jobs/create` |

If an app needs job triggers or paprAPI on cloud later, tell the user those features require Paprwork desktop open, or redesign around `/api/db/*` for cloud-first flows.

Users can disable auto-publish globally or per-app in Settings.

## Required UX States

Every app must handle four states:

1. **Loading** - Skeleton/spinner while querying
2. **Empty** - Helpful message: "Run the sync job to populate data"
3. **Error** - Clear error with retry action
4. **Success** - Real data displayed

## Best Practices

- Define the contract BEFORE writing any code
- Keep aliases domain-specific (e.g., "leads", "funnel", "crm")
- Document retention policy in the contract
- Use nullable columns for backward-compatible migrations
- Test all four UX states with realistic data
- Re-run `run_job` after schema changes to verify compatibility
