---
id: preloaded-papr-api-reference
name: Papr API Reference (lookup)
description: How to find Papr platform API contracts — mini-app HTTP, SDK, and agent tools. Use get_papr_api_reference first; this skill covers workflow and common patterns.
---
# Papr API Reference

## Golden rule

> **Contract** (method, path, body, limits) → `get_papr_api_reference({ query: "..." })`  
> **Workflow** (stages, architecture, anti-patterns) → `read_skill({ skillId: "preloaded-app-and-jobs-guide" })`

Do not discover Papr APIs via memory search, grep, or curl loops on `localhost:18789`.

---

## Surfaces

| Surface filter | What it covers |
|----------------|----------------|
| `mini-app-http` | Same-origin `/api/*` from mini-app iframe (desktop + cloud) |
| `mini-app-sdk` | `import { papr } from '/__papr__/papr-sdk.ts'` and related modules |
| `agent-tool` | Chat agent tools (`create_app`, `run_job`, memory, etc.) |
| `desktop-gateway` | Paprwork gateway routes while building (sync, publish) |
| `cloud-gateway` | Subset also on `apps.papr.ai` |

---

## High-traffic mini-app patterns

### Reads — prefer batch

```javascript
const res = await fetch('/api/db/batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    statements: [
      { sql: 'SELECT COUNT(*) AS n FROM leads' },
      { sql: 'SELECT * FROM settings LIMIT 1' },
    ],
  }),
});
const { results } = await res.json();
```

Aliases: `/api/db/query-batch`, `/api/db/read-batch` (same handler).

### Writes — prefer write-batch + atomic

```javascript
await fetch('/api/db/write-batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    atomic: true,
    statements: [
      { sql: 'INSERT INTO t (k) VALUES (?)', params: ['a'] },
      { sql: 'INSERT INTO t (k) VALUES (?)', params: ['b'] },
    ],
  }),
});
```

Limit: **25** statements per batch read or write.

### Live refresh — SDK not raw SSE

```javascript
import { papr } from '/__papr__/papr-sdk.ts';

papr.jobs.subscribe({
  jobIds: [JOB_ID],
  dbIds: [REGISTRY_DB_ID],
  debounceMs: 300, // optional — coalesce onDbChanged when loadData is heavy
  onDbChanged: () => loadData(),
});
```

Route: `GET /api/jobs/events` (SSE) — see catalog entry `jobs-events-sse`.

---

## Agent equivalents

| Mini-app HTTP | Agent tool |
|---------------|------------|
| `/api/jobs/run` | `run_job` |
| `/api/jobs/create` | `create_job` |
| `/api/db/*` | Build app code; agent uses `read_app_file` / `write_file` on app sources |
| Cloud publish | `publish_cloud_app`, `get_cloud_publish_config` |

---

## Debug (humans / scripts)

- Full JSON: `GET http://localhost:18789/api/dev/papr-api-catalog`
- Search: `GET http://localhost:18789/api/dev/papr-api-catalog?q=write-batch&surface=mini-app-http`

Generated file on disk: `src/resources/papr-api-catalog.json` (rebuilt on `npm run build:gateway`).
