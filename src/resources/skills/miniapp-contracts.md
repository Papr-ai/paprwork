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
- Database: ~/PAPR/jobs/{jobId}/data.db
- Tables:
  - `table_name`: columns, types, constraints
- Indexes: which columns, matching which queries
- Write frequency: how often data is updated
- Retention: how long data is kept

### Read Model (what the app queries)
- Queries: exact SQL the app will run
- Refresh: how often the app re-queries
- Fallback: what to show when data is empty/missing

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

## Linking Apps to Data

Use `link_app_data_source` to wire an app to a job's database:

```javascript
link_app_data_source({
  appId: "funnel-dashboard",
  jobId: "amplitude-sync",
  alias: "funnel",
  tables: ["funnel_runs"]
})
```

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
