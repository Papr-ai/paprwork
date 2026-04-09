---
id: preloaded-sqlite-analytics
name: SQLite Analytics
description: Build and query SQLite workflows for jobs and mini-apps with proper schema design.
---
# SQLite Analytics

Design and manage SQLite databases for Papr jobs and mini-apps. Each job gets its own `data.db` file at `~/Papr/jobs/{jobId}/data.db`.

## Schema Design

### Design Tables First
Before writing job code, define the schema explicitly:

```sql
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  value REAL NOT NULL,
  metadata TEXT,  -- JSON for flexible extra data
  created_at TEXT DEFAULT (datetime('now'))
);
```

### Add Indexes for Query Paths
Match indexes to how the mini-app will query data:

```sql
CREATE INDEX IF NOT EXISTS idx_metrics_date ON metrics(date);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_metrics_date_name ON metrics(date, metric_name);
```

### Common Patterns

**Time-series data:**
```sql
CREATE TABLE time_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,
  value REAL,
  tags TEXT,  -- JSON array
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_ts_timestamp ON time_series(timestamp);
CREATE INDEX idx_ts_source ON time_series(source, timestamp);
```

**Key-value store:**
```sql
CREATE TABLE kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

**Entity tracking (leads, contacts, etc.):**
```sql
CREATE TABLE entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  data TEXT NOT NULL,  -- JSON blob
  score REAL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_status ON entities(status);
```

## Idempotent Migrations

Use a migrations table to track schema versions:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

-- Check if migration already applied
SELECT version FROM schema_migrations WHERE version = 1;
-- If not found, run migration and record it
INSERT INTO schema_migrations (version) VALUES (1);
```

## Querying from Mini-Apps

Apps query job databases via the linked data source:

```javascript
// In mini-app JavaScript
async function query(sql) {
  const result = await window.electronAPI.executeCommand(
    `sqlite3 -json "${dbPath}" "${sql}"`
  );
  return JSON.parse(result.stdout);
}

// Example queries
const today = await query("SELECT * FROM metrics WHERE date = date('now')");
const trend = await query("SELECT * FROM metrics ORDER BY date DESC LIMIT 7");
const total = await query("SELECT COUNT(*) as count FROM entities WHERE status = 'active'");
```

## Retention Policy

Set `retentionDays` in job config to auto-clean old data:

```sql
-- Clean up old records (run in job)
DELETE FROM metrics WHERE created_at < datetime('now', '-90 days');
```

## Best Practices

- Always define schema before writing job code
- Use JSON columns for flexible/evolving data
- Add indexes that match your app's query patterns
- Use `INSERT OR REPLACE` for upsert operations
- Test queries with `sqlite3` CLI before wiring to app
- Keep databases under 100MB for responsive UI queries
