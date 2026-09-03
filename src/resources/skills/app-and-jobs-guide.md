---
id: preloaded-app-and-jobs-guide
name: App & Jobs Workflow Guide
description: Complete workflow for building Paprwork mini-apps and jobs — stage flow, tools reference, file structure, SQLite integration, job triggering, WebSocket push updates, and anti-patterns. Read this before building any app or job.
---
# App & Jobs Workflow Guide

> **Read this before building any mini-app, job, or app+job pipeline.**
> The REST API reference (endpoints, params, bash, WebSocket) is always in your system prompt. This guide covers the *workflow* — how to sequence the steps correctly.

---

## Golden Rule

> **Mock the UI first, show the user, get approval, THEN build the backend.**
> **Test each piece independently before connecting them.**

---

## Stage Flow (always follow this order)

1. **Prototype UI** — `create_app` with placeholder/hardcoded data. Load the design system skill (`preloaded-paprwork-design-system`) first. Align on all states before writing backend.
2. **Validate upstream data** — Run small probes with `bash` before committing schema. Check real field names, pagination, auth constraints.
3. **Define contracts** — Lock the SQLite write model (what jobs write) and read model (what app queries). Add indexes for app query paths.
4. **Implement jobs** — `create_job` → `run_job` → `read_job_logs`. Adjust schema based on real output.
5. **Wire app to data** — `create_database` → `attach_database` → `/api/db/query` and `/api/db/write` with `sourceId`. Jobs use `writeDbIds`. Validate end-to-end with realistic data across all UI states.

If the task is explicit and small, merge steps. Always explain tradeoffs when skipping discovery.

---

## Agent Tools Reference

| Tool | Purpose |
|------|---------|
| `list_apps` | List existing mini-apps — **call first** before creating |
| `create_app` | Create a mini-app with HTML/CSS/JS files |
| `read_app_file` / `edit_file` / `edit_app_file_lines` / `list_app_files` | Read, patch, line-edit, list app source files |
| `list_jobs` | List all jobs — **call first** before creating |
| `create_job` | Create a job (shell/python/node/agent type) |
| `update_job` | Patch job config (command, schedule, deps, env) |
| `run_job` | Execute a job and wait for output |
| `read_job_logs` | Read execution logs for a job |
| `list_job_files` / `read_job_file` / `edit_file` | Browse and patch job scripts |
| `link_app_data_source` | Attach job DB or registry `dbId` to app (prefer `attach_database` for registry DBs) |
| `create_database` | Create standalone registry DB |
| `attach_database` | Link registry `dbId` to mini-app with optional `alias` |
| `read_app_data_sources` | List registered data sources for an app |
| `read_skill` | Load a skill for detailed guidance |

> Mini-app REST APIs: **`/api/db/query`** (single read), **`/api/db/batch`** (batch reads; aliases `query-batch`, `read-batch`), **`/api/db/write`** (single write), **`/api/db/write-batch`** (batch writes — default **`atomic: false`**, optional **`atomic: true`** on same database), **`/api/db/exec`** (CREATE TABLE IF NOT EXISTS only), **`/api/app/backend/:action`**, **`/api/jobs/run`**, **`/api/credentials/client-keys`** (publishable keys only). **`/api/bash/run` is disabled** for mini-apps.

---

## App backend + vault keys (read before porting jobs to backend/)

When a mini-app needs a **secret API key** server-side (no CORS, key must not reach browser):

1. **Create** `apps/{appId}/backend/manifest.json` and handler script.
2. **Declare keys on each action** in backend manifest: `"keys": ["RR_ATTENTION_API_KEY"]` (exact name from Settings → Integration Keys).
3. **Cloud only — also register in catalog:** same key names must appear in `requirements.json` with `credentialScope: "owner"` and `clientAccess: "server"`. **Cloud publish auto-syncs** backend manifest keys into `requirements.json` — you do not need to hand-edit if you republish.
4. **Handler reads env** — gateway injects automatically:
   - Python: `os.environ["RR_ATTENTION_API_KEY"]`
   - Node/TS: `process.env.RR_ATTENTION_API_KEY`
4. **Frontend calls** (params must be nested):
```typescript
await fetch('/api/app/backend/fetch-calls', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId: APP_ID, params: { limit: '50' } }),
});
```

**❌ NEVER when wiring backend keys:**
- Grep/read `custom-keys.json`, Keychain, or `~/.paprwork-v2`
- Call `get_key` tool or `/api/keys/*` from handler code
- Hardcode secrets in source
- Use `/api/bash/run` from mini-apps (disabled)
- **Cloud:** Rely on backend manifest `keys` alone without `requirements.json` in the published catalog (vault-resolve will fail with "No matching catalog requirements")

**Two-layer model (both required on cloud):**
| Layer | File | Purpose |
|-------|------|---------|
| Per-action allowlist | `backend/manifest.json` → `"keys"` | Which keys this handler may receive |
| App catalog | `requirements.json` | Cloud vault registry (what keys exist for this app) |

Desktop injects from Settings directly. Cloud injects from GCP vault **only for keys in the published catalog**.

**Publishable browser-safe keys** (Google Maps embed, Stripe publishable): mark **Browser-safe** in Settings, add `clientAccess: "client"` in `requirements.json`, then `POST /api/credentials/client-keys` from frontend — **not** the manifest `keys` array.

**Secret keys with CORS-blocked APIs** (Attention, most private APIs): use **backend** + manifest `keys` array — not client-keys.

See APP_AND_JOBS_GUIDE.md § App backend for full manifest example.

### Verified caller identity (multi-user / ACL backends)

**NOT row-level SQL.** No `papr_current_user()`, no `/api/db/secure-query`, no `/api/db/action`. `/api/db/query` is unchanged — any SELECT still runs.

**Mechanism:** `POST /api/app/backend/{actionName}` — `actionName` from `apps/{appId}/backend/manifest.json`. Handler gets env `PAPR_CALLER_USER_ID` (session-trusted).

**Older apps:** may have no `backend/` folder — endpoint returns **ENOENT** on manifest (route is live, not 404). Scaffold before verify.

**Minimal manifest (copy verbatim — `version` is numeric `1`, field is `handler` not `entry`):**
```json
{
  "version": 1,
  "actions": {
    "ping": {
      "handler": "ping.py",
      "runtime": "python",
      "timeoutMs": 10000
    }
  }
}
```

**Params env:** `PAPR_ACTION_PARAMS` (JSON) + `PAPR_PARAM_{key}` per param. **No `PAPR_PARAMS_JSON`.** Spoofed `PAPR_CALLER_USER_ID` in params is **overwritten** — `PAPR_PARAM_PAPR_CALLER_USER_ID` = session id (fail-safe).

**Common wrong probes (all fail):** `SELECT papr_current_user()`, `/api/db/action`, `/api/app-actions`.

**Verify:**
```bash
curl -s -X POST http://localhost:18789/api/app/backend/ping \
  -H "Content-Type: application/json" \
  -d '{"appId":"APP_ID","params":{"PAPR_CALLER_USER_ID":"fake"}}'
# stdout JSON: callerUserId = real session id, NOT "fake"
```

When a backend handler must know **who invoked it** (roster lookup, role-scoped reads, passcode claim):

- **`POST /api/app/backend/:action`** and **`POST /api/jobs/run`** inject server env vars when the caller is signed in — they **override** any client spoofing in `params` (including `PAPR_PARAM_*` copies of identity keys).
- **`PAPR_CALLER_USER_ID`** — Papr user id (Parse objectId); use for ACL and roster binding.
- **`PAPR_CALLER_EMAIL`** — when email is known from session.
- **Optional** for public/ping handlers — ignore when identity is not needed.
- **Never** authorize from client `userId`, `role`, or other business identity params — only `PAPR_CALLER_USER_ID` / `PAPR_CALLER_EMAIL`.

```python
user_id = os.environ.get("PAPR_CALLER_USER_ID")
if not user_id:
    sys.exit("Sign in required")
# lookup role from roster WHERE papr_user_id = user_id
```

```typescript
const userId = process.env.PAPR_CALLER_USER_ID;
if (!userId) throw new Error("Sign in required");
```

For sensitive multi-role apps: put reads/writes in backend actions (not raw `/api/db/query` from the browser). See system prompt § **Backend ACL — what changed vs what did NOT**.

### Backend linked database (local + cloud)

When a backend handler must **read or write** linked SQLite/Turso databases:

1. **Ensure sources are linked** — `create_database` → `attach_database({ alias })`
2. **Name the DB** — `"sourceId": "billing"` on the action in `manifest.json`, or `params: { sourceId: "billing" }` from the frontend
3. Gateway injects **every** linked source as `PAPR_DB_{KEY}*` plus `APP_DB` for the active source
4. **Python:** `from papr_db import connect, execute` — `connect("billing")` or `connect()`; never `sqlite3.connect(APP_DB)` (cloud uses Turso). Insert id: `INSERT … RETURNING`, or `con.lastrowid` after INSERT.
5. **Node/TS:** No cross-env DB helper — use Python backend handlers for SQL, or `/api/db/*` from the frontend.

**❌ NEVER:** parse `data-sources.json` manually, grep keychain for DB paths, or read API keys from SQLite.

**Simple form-only save (no backend logic):** frontend `POST /api/db/write` with `sourceId` — no backend action needed.

---

> **Cloud (automatic, ready):** Synced apps auto-publish to `apps.papr.ai`. Use **`attach_database`** / `link_app_data_source` so `data-sources.json` exists (required for cloud `/api/db/*`). `/api/db/*` and `/api/jobs/run` work on cloud; **`window.paprAPI` is desktop-only**. **Never use `/tmp` file IPC between jobs and mini-apps** — use `writeDbIds` + `/api/db/*` with `sourceId` and job `params` instead. See APP_AND_JOBS_GUIDE.md § Mini-app ↔ job communication.

---

## Job Resilience Quick Reference

When creating jobs, consider resilience needs:

**One-shot jobs (API calls):**
- Add `retries: { maxAttempts: 3, backoffMs: 2000 }`
- Handles rate limits, network timeouts

**Long-running jobs (large datasets):**
- Use `useCheckpointTemplate: true` to generate resumable code
- Add retries for max resilience
- Script saves progress every N items

**Scheduled jobs:**
- Set `catchUpMissed: true` on cron schedules
- Runs missed occurrences on app startup

See full patterns in APP_AND_JOBS_GUIDE.md → "Job Resilience & Patterns"

---

## File Structure

```
$PAPR_HOME/apps/{appId}/
  index.html            # Entry point — NO inline JS, load app.ts as module
  style.css             # Liquid Glass styles
  app.ts                # Main entry (TypeScript — auto-transpiled by gateway)
  types.ts              # Shared interfaces
  components/           # One component per file (<150 lines each)
  utils/                # Helpers, formatters, API calls
  data-sources.json     # Created by attach_database / link_app_data_source

$PAPR_HOME/Jobs/{jobId}/
  job.json              # Config (schedule, type, command, env, deps)
  code/main.py          # (Python) or code/main.js (Node) or code/run.sh (Shell)
  code/requirements.txt # Python dependencies
  data/data.db          # SQLite — job writes here, app reads here
  logs/                 # Execution logs (read with read_job_logs)
```

**index.html must follow this structure:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App Name</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="app.ts"></script>
</body>
</html>
```

---

## SQLite Workflow

### Step 1 — Create and attach database

```javascript
const { dbId } = await create_database({ name: "Dashboard data" })
await attach_database({ appId, dbId, alias: "main" })
create_job({
  name: "Sync",
  appIds: [appId],
  writeDbIds: [dbId],
  type: "python",
  command: 'python3 code/main.py --db "$PAPR_DB_MAIN"',
})
```

Manual link fallback: `link_app_data_source({ appId, jobId, alias: "sync" })` or `{ dbId, alias }`.

**Env vars in jobs:** `PAPR_DB_{ALIAS}` from `writeDbIds`. `$JOB_DB` = scratch only.

### Step 2 — Inspect schema (optional, from app JS)
```javascript
const { sources } = await fetch('/api/db/schema?appId=APP_ID').then(r => r.json());
// sources[0].tables → [{ table: "threads", columns: [...] }]
```

### Step 3 — Query in app code

Pass **`sourceId`** = alias from `attach_database`. Required when 2+ DBs linked; optional when only one.

```typescript
const APP_ID = 'your-app-id';

async function loadData() {
  const { rows } = await fetch('/api/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: APP_ID,
      sourceId: 'main',
      sql: 'SELECT * FROM threads ORDER BY score DESC LIMIT 100',
    })
  }).then(r => r.json()) as { rows: Thread[] };
  return rows;
}
```

### Step 4 — Write from app code (UPDATE / INSERT / DELETE)

All linked DBs are **writable**. Use `/api/db/write` (not `/api/db/query` — mutations return 403 on query).

```typescript
const { changes } = await fetch('/api/db/write', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appId: APP_ID,
    sourceId: 'main',
    sql: 'UPDATE threads SET status = ? WHERE id = ?',
    params: ['selected', threadId],
  })
}).then(r => r.json()) as { changes: number };

const { lastInsertRowid } = await fetch('/api/db/write', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appId: APP_ID,
    sourceId: 'main',
    sql: 'INSERT INTO actions (thread_id, action, created_at) VALUES (?, ?, datetime("now"))',
    params: [threadId, 'regenerate'],
  })
}).then(r => r.json()) as { lastInsertRowid: number };
```

**Security:** Only `INSERT`, `UPDATE`, `DELETE`, `REPLACE` on `/api/db/write`. Only databases in `data-sources.json`. Always use `params` with `?` placeholders.

**Write vs trigger a job:** Use `/api/db/write` for direct state changes the app owns (select, flag, delete). Use `/api/jobs/run` when the change requires backend processing (LLM call, API call, complex logic).

### Batch reads and writes (two lanes — do not mix)

| Lane | Endpoint | Use when |
|------|----------|----------|
| Read batch | `POST /api/db/batch` (aliases: `query-batch`, `read-batch`) | 2+ **SELECT**s on mount — one HTTP round trip, max 25 statements |
| Write batch | `POST /api/db/write-batch` | 2+ **INSERT/UPDATE/DELETE** in one user action — max 25 statements |

- **Never** put INSERT/UPDATE/DELETE in `/api/db/batch` — each statement gets `{ ok: false, error: "Only SELECT..." }`.
- **`write-batch` returns `{ atomic, results }`** — default **`atomic: false`**: statements commit one at a time; check every `results[i].ok`. Pass **`atomic: true`** for all-or-nothing on the **same linked database** (`sourceId`).
- Cross-database sequences still need **`/api/app/backend/:action`** or a job.

```typescript
// Batch read — page load
const { results } = await fetch('/api/db/batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appId: APP_ID,
    statements: [
      { sourceId: 'main', sql: 'SELECT * FROM people LIMIT 50' },
      { sourceId: 'main', sql: 'SELECT * FROM settings WHERE id = 1' },
    ],
  }),
}).then(r => r.json());
```

---

## Mini-App System Integration (window.paprAPI)

**Sandbox ≠ no chat:** Iframe sandbox blocks `window.open()` and native clipboard — **not** `window.paprAPI`. Mini-apps **can** open main Paprwork chat on desktop via `chat.open`. Do **not** tell users there is no iframe API for chat.

| Button goal | Pattern |
|-------------|---------|
| Conversational ("Ask Agent", "Discover X") | `paprAPI.invoke('chat.open', { message: '…' })` (desktop only) |
| Background AI, user stays in app | `POST /api/jobs/run` |
| Sidebar MiniChat | ❌ App cannot call `delegate_task` — main agent only |

Mini-apps run in sandboxed iframes where native browser APIs for system actions are blocked. Use `window.paprAPI.invoke()` instead:

### Common Patterns

```typescript
// Download/save file
await window.paprAPI.invoke('dialog.showSaveDialog', {
  defaultPath: 'data.csv',
  content: csvData,
  filters: [{ name: 'CSV', extensions: ['csv'] }]
});

// Open external links (mailto, https)
await window.paprAPI.invoke('shell.openExternal', 'mailto:user@example.com?subject=Hello');
await window.paprAPI.invoke('shell.openExternal', 'https://github.com/user/repo');

// Copy to clipboard
await window.paprAPI.invoke('clipboard.writeText', 'text to copy');

// Show desktop notification
await window.paprAPI.invoke('notification.show', {
  title: 'Task Complete',
  body: 'Data export finished!'
});

// Show file in Finder/Explorer
await window.paprAPI.invoke('shell.showItemInFolder', '/path/to/file.csv');

// Move to trash
await window.paprAPI.invoke('shell.trashItem', '/path/to/file');

// Open new chat from the mini-app (e.g. "Ask agent" on a dashboard card)
await window.paprAPI.invoke('chat.open', {
  message: 'Context from app: …', // optional draft in composer
  model: 'gpt-5.4',              // optional — same ids as model picker
});
```

### Available APIs

- `shell.openExternal(url)` - Open mailto/https/file URLs in default app
- `dialog.showSaveDialog(options)` - Save file picker
- `dialog.showOpenDialog(options)` - Open file picker
- `clipboard.writeText(text)` / `clipboard.readText()` - Clipboard access
- `notification.show(options)` - Desktop notifications
- `shell.showItemInFolder(path)` - Reveal file in file manager
- `shell.trashItem(path)` - Move file to trash
- `dialog.showMessageBox(options)` - Show alert/confirm dialog
- `app.getPath(name)` - Get system paths (downloads, documents, etc.)
- `chat.open(options?)` - New chat tab; optional `message` (composer draft), `model`, `provider`
- **Never** use `paprwork://` URLs, `window.paprwork`, or `window.electronAPI` inside mini-apps — use `window.paprAPI.invoke` only

### Why Native APIs Don't Work

Mini-apps run in sandboxed iframes with restricted permissions:
- `<a download>` - Blocked by iframe sandbox
- `window.open()` - Opens inside iframe, not in external browser
- `navigator.clipboard` - Requires user gesture in main frame
- `new Notification()` - Blocked by iframe permissions

`window.paprAPI` bridges to Electron's native APIs via secure IPC to the main process.

---

## Bash tool vs create_job (agent work)

**Default: `bash` for one-offs. `create_job` only when reusable.**

| `bash` tool | `create_job` |
|-------------|--------------|
| One-time curl/API probe, sqlite peek, package install | App button, schedule, or named rerun |
| Explore data before schema design | Writes to `$APP_DB` for linked mini-app |
| Quick fix "run this once now" | Pipeline with `dependsOn`, retries, delivery |

❌ **Don't** create orphan `type: "python"` jobs for a single curl or query. ✅ **Do** bash first, then promote to a job when the user needs it again or the app wires to it.

---

## Job Types (choose correctly)

| Type | Use for | Example |
|------|---------|---------|
| `python` | Scripts with logic, API calls, data processing, ML | `command: "python3 code/main.py --token ${GITHUB_TOKEN}"` |
| `bash` | Simple shell one-liners | `command: "curl -H 'Authorization: Bearer ${KEY}' ..."` |
| `node` | Node.js/TypeScript scripts | `command: "node code/main.js", requiredKeys: ["KEY"]` |

**Use `type: "python"` when:** The job has multi-step logic, API calls, data processing, or needs pip packages. Pass API keys as CLI arguments in the command.

**Use `type: "bash"` when:** The job is a simple command or one-liner (curl, git, jq). Keys go directly in the command string.

---

## OAuth vs API Key for Jobs

| Job type | OAuth (ChatGPT/Claude subscription) | API key (Platform) |
|----------|-------------------------------------|--------------------|
| **Agent jobs** | ✅ Works — Paprwork routes to pi-ai automatically | ✅ Works — uses AI SDK |
| **Bash/Python jobs** calling OpenAI/Anthropic | ❌ OAuth token won't work | ✅ Needs Platform API key |

**Agent jobs** — No setup needed. Paprwork detects OAuth vs API key and routes to the right backend (pi-ai for OAuth, AI SDK for API key). When creating sub-agents for agent jobs, use models from `preloaded-subagent-guide` — pick ones the user has access to (OAuth or API key). Default: `gpt-5.4` or `claude-sonnet-4-6`.

**Bash/Python jobs** that call `openai` Python SDK or `curl api.openai.com` — Require a **Platform API key** in Settings. OAuth tokens are for the ChatGPT backend, not the Platform API. If the user only has OAuth, tell them: "For Python/bash jobs that call the OpenAI API, add an OpenAI Platform API key in Settings → API Keys. Your ChatGPT subscription works for chat and agent jobs, but scripts need the Platform key."

### ⚠️ CRITICAL: Don't call LLMs directly from Python/bash jobs!

**❌ WRONG - Calling OpenAI/Anthropic APIs directly:**
```python
# DON'T DO THIS - bypasses Paprwork's OAuth/API key routing
import openai
response = openai.chat.completions.create(
    model="gpt-5.4",
    messages=[{"role": "user", "content": prompt}]
)
```

**Why this fails:**
- OAuth tokens (ChatGPT subscription) don't work with Platform API endpoints
- Requires Platform API key even if user has OAuth
- No automatic fallback from OAuth → API key
- No rate limit handling

**✅ CORRECT - Use agent jobs instead:**

When you need LLM calls in a pipeline, use **agent jobs** (type: "agent" or "subagent"), not Python/bash jobs with direct API calls:

```javascript
// Create a sub-agent for the LLM task
create_sub_agent({
  id: "reviewer-agent",
  name: "Content Reviewer",
  description: "Reviews and polishes content",
  systemPrompt: "You review content for clarity, tone, and accuracy. Output only the polished version.",
  provider: "openai",
  model: "gpt-5.4"
})

// Create an agent job that uses the sub-agent
create_job({
  name: "Review Posts",
  type: "subagent",
  subAgentId: "reviewer-agent",
  command: "Review the following post for clarity and fix any issues: [post content]",
  outputMode: "natural"
})
```

**Benefits of agent jobs:**
- ✅ Automatic OAuth → API key routing (uses ChatGPT subscription first, falls back to Platform API)
- ✅ Rate limit handling (auto-retries with API key if OAuth rate limited)
- ✅ Works whether user has OAuth, API key, or both
- ✅ No manual API code needed
- ✅ Consistent with chat behavior

**When to use Python/bash jobs:**
- ✅ Data processing (pandas, SQL, file parsing)
- ✅ External API calls (Reddit, GitHub, etc.)
- ✅ System commands (git, curl non-LLM endpoints)
- ✅ Data transformation before/after LLM calls

**Pipeline pattern:**
```javascript
// 1. Python job: Fetch data
create_job({
  name: "Fetch Reddit Posts",
  type: "python",
  command: "python3 code/fetch.py --reddit-token ${REDDIT_TOKEN}",
  // Writes posts to SQLite
})

// 2. Agent job: Process with LLM (autoTrigger: true = start when fetch job completes)
create_job({
  name: "Review Posts",
  type: "subagent",
  subAgentId: "reviewer-agent",
  dependsOn: [{ jobId: "fetch-reddit-posts", onStatus: "completed", autoTrigger: true }],
  // Reads from fetch job's SQLite, processes with LLM, writes results
})

// 3. Python job: Format output
create_job({
  name: "Export Results",
  type: "python",
  command: "python3 code/export.py",
  dependsOn: [{ jobId: "review-posts", onStatus: "completed", autoTrigger: true }],
  // Reads reviewed posts, formats for delivery
})
```

### Calling Agent Jobs from Python Scripts

**Two patterns for using LLMs in jobs:**

| Pattern | Structure | Use Dependencies? | Use Case |
|---------|-----------|-------------------|----------|
| **Pipeline** | 3 separate jobs: Python → Agent → Python | ✅ YES: `dependsOn` in job config | Simple linear flow, retry steps separately |
| **Embedded Call** | 1 Python job that calls agent job via HTTP | ❌ NO: HTTP call in Python code | LLM calls in loops, complex control flow |

#### Pattern 1: Pipeline (with dependencies)

Create 3 separate jobs with `dependsOn` and **`autoTrigger: true`** on each dependency so the next job **starts by itself** when the previous one finishes (any job types: python, subagent, agent, etc.). Without `autoTrigger`, `dependsOn` only orders runs when you start a job another way (`run_job`, schedule, or a later job pulling the chain).

```javascript
create_job({ name: "Fetch", type: "python" })
create_job({ 
  name: "Review", 
  type: "subagent", 
  dependsOn: [{ jobId: "fetch", onStatus: "completed", autoTrigger: true }]
})
create_job({ 
  name: "Export", 
  type: "python", 
  dependsOn: [{ jobId: "review", onStatus: "completed", autoTrigger: true }]
})
```

**Flow:** When Fetch completes, Review auto-starts; when Review completes, Export auto-starts. If you only need ordering when manually running Export, you can omit `autoTrigger` on those entries.

#### Pattern 2: Embedded Call (Python calls agent)

**Yes, you can call agent jobs from within a Python script!** This is perfect when you need LLM calls in the middle of data processing.

Create 2 separate jobs with NO dependencies:

```javascript
// 1. Create agent job (reusable LLM service)
create_sub_agent({
  id: "post-reviewer",
  name: "Post Reviewer",
  systemPrompt: "Review posts. Return JSON: {\"content\": \"reviewed text\"}",
  provider: "openai",
  model: "gpt-5.4"
})

create_job({
  name: "Review Post Agent",
  type: "subagent",
  subAgentId: "post-reviewer",
  command: "Review this post: ${POST_CONTENT}"
  // NO dependsOn - this is a standalone service
})

// 2. Create Python job (calls agent via HTTP)
create_job({
  name: "Process Posts",
  type: "python",
  command: "python3 code/main.py",
  requirements: ["requests"]
  // NO dependsOn - makes HTTP calls internally
})
```

**Python script that calls the agent job:**

```python
# Python job that calls an agent job for LLM work
import requests
import json

# 1. Fetch and process data
posts = fetch_reddit_posts()

# 2. Call agent job to review each post (LLM call with OAuth/API key routing)
for post in posts:
    response = requests.post('http://localhost:18789/api/jobs/run', json={
        'jobId': 'review-post-agent',  # The agent job we created
        'wait': True,  # Block until completion
        'params': {
            'POST_CONTENT': post['content'],
            'POST_ID': post['id']
        }
    })
    
    result = response.json()
    if result['status'] == 'completed' and result.get('lastOutput'):
        # Get LLM result from agent job
        reviewed = json.loads(result['lastOutput'])
        post['reviewed_content'] = reviewed['content']
        print(f"✓ Reviewed post {post['id']}")
    else:
        print(f"✗ Failed: {result.get('error')}")

# 3. Continue processing with LLM results
save_to_database(posts)
```

**Flow:** Python script makes HTTP requests to `/api/jobs/run` - just like calling any API.

**How it works:**
1. Python job calls `/api/jobs/run` with `wait: true`
2. Agent job runs with OAuth → API key routing (automatic fallback)
3. Python job receives `lastOutput` from agent job
4. Python continues with LLM results

**Benefits:**
- ✅ Single job handles entire workflow
- ✅ LLM calls get proper OAuth/API key handling
- ✅ Rate limit fallback works automatically
- ✅ Can process items in a loop with LLM calls
- ✅ Agent job is reusable - any job can call it

**When to use each pattern:**

Use **Pipeline** when:
- Simple fetch → process all → export
- Want to retry steps independently
- Each step is a distinct phase

Use **Embedded Call** when:
- Need LLM calls inside a loop (process 100 posts one-by-one)
- LLM call depends on intermediate computation
- Complex control flow (if/else, retries, batching)
- Single atomic job is clearer than pipeline

---

## API Keys in Jobs

**Custom API keys (from Settings) are NOT in the job environment.** Pass them as CLI arguments:

```javascript
// ✅ Python job — keys as CLI args
create_job({
  name: "GitHub Sync",
  type: "python",
  command: "python3 code/fetch.py --github-token ${GITHUB_TOKEN}",
  requirements: ["requests"]
})
```

```python
# code/fetch.py
import argparse
parser = argparse.ArgumentParser()
parser.add_argument('--github-token', required=True)
args = parser.parse_args()
token = args.github_token  # ✅ Receives actual value
```

**❌ Do NOT:** Put `${GITHUB_TOKEN}` in the Python file. Substitution happens in the command string only.

**❌ Do NOT:** Use `os.getenv('GITHUB_TOKEN')` for custom keys — they are not in the environment.

**Runtime params** (THREAD_ID, ACTION, etc.) ARE in the environment — use `os.environ.get('THREAD_ID')` for those.

---

## Job Design Principles

When a job will be triggered by a button click:
1. **Idempotent** — running twice on same input produces same result
2. **Write to SQLite** — app re-queries after completion, no other IPC needed
3. **Fast** (<30s) — long jobs should update a `status` column in SQLite so app shows progress
4. **Three environment layers** — don't confuse them:

| Layer | Set by | Available in job |
|-------|--------|-------------------|
| API keys (custom from Settings) | `create_job` command | Declare `requiredKeys: ["KEY_NAME"]` and read `os.environ["KEY_NAME"]` / `process.env.KEY_NAME`. |
| Job config env (`SUBREDDIT=python`) | `create_job` / `update_job` | `os.environ`, `$VAR` |
| Runtime params (`THREAD_ID=abc123`) | `params` in `/api/jobs/run` | `os.environ.get('THREAD_ID')`, `$THREAD_ID` |

Runtime params: `os.environ.get('THREAD_ID')`. API keys: declare requiredKeys and read from os.environ/process.env; never pass secrets as CLI args.

---

## Job Triggering Patterns

> **Live updates:** import from `/__papr__/papr-job-events.ts` (runtime SDK). See system prompt and this skill.
> Run `validate_app` after edits — it returns a copy-paste snippet when polling anti-patterns are detected.

**Three ways a job can send data back to the app:**

| Output type | Pattern | How job delivers |
|-------------|---------|-----------------|
| Short text (draft, answer, summary) | `wait: true` → `lastOutput` | `print()` / `echo` to stdout |
| Structured data (lists, records) | SQLite + WebSocket push | Write to `data.db` |
| Simple status | WebSocket `jobs:status-changed` | Just completing the job |

### Pattern 1: Inline output — job prints, app reads directly (simplest for short responses)

Use when the job produces a short text result (a draft, a summary, an answer). The job's stdout is captured and returned in the HTTP response — no SQLite, no WebSocket needed.

**Job config** (API key via CLI arg, runtime param via env):
```javascript
create_job({
  name: "Draft Generator",
  type: "python",
  command: "python3 code/main.py --anthropic-key ${ANTHROPIC_API_KEY}",
  requirements: ["anthropic"]
})
```

**Job script:**
```python
# Python job — API key from argparse, runtime param from os.environ
import json, os, argparse

parser = argparse.ArgumentParser()
parser.add_argument('--anthropic-key', required=True)
args = parser.parse_args()

thread_id = os.environ.get('THREAD_ID', '')  # Runtime param — from /api/jobs/run params
draft = generate_reply(thread_id, args.anthropic_key)  # API key from CLI
print(json.dumps({ "draft": draft, "threadId": thread_id }))
```

**App code:**
```typescript
const res = await fetch('/api/jobs/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jobId: JOB_ID, wait: true, params: { THREAD_ID: id } })
});
const { status, lastOutput, error } = await res.json() as {
  status: string; lastOutput?: string; error?: string;
};
if (status === 'completed' && lastOutput) {
  const result = JSON.parse(lastOutput) as { draft: string; threadId: string };
  showDraft(result.draft);
}
```

`lastOutput` is also included in the WebSocket `jobs:status-changed` event, so fire-and-forget + WebSocket push works too.

### Pattern 2: Structured data — job writes to SQLite, app auto-refreshes (preferred for dashboards/lists)

```typescript
import { subscribeJobEvents } from '/__papr__/papr-job-events.ts';

const JOB_ID = 'your-job-id';

// Auto-refresh when DB data changes (any write path: job, agent, Turso pull)
const unsub = subscribeJobEvents({
  jobIds: [JOB_ID],
  onDbChanged: () => loadData(),          // DB content changed → re-query
  onStatusChanged: (e) => {               // Job lifecycle → update status badge
    if (e.status === 'completed' || e.status === 'failed') updateStatus(e);
  },
  onProgress: (e) => updateProgress(e),   // Real-time progress bars
});

// Trigger the job (fire-and-forget — events handle the rest)
async function triggerJob(params?: Record<string, string>) {
  await fetch('/api/jobs/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: JOB_ID, params })
  });
}
```

> **Do NOT poll `/api/db/query` on a `setInterval`.** Cloud apps bill Turso per row read — polling can cost millions of reads. Use `onDbChanged` for automatic data-driven refresh.


### Pattern 3: Polling (fallback when WebSocket unavailable)

```typescript
async function pollJob(jobId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const { status } = await fetch(`/api/jobs/status/${jobId}`).then(r => r.json()) as { status: string };
    if (status === 'completed' || status === 'failed') return status;
  }
  return 'timeout';
}
```

### Button loading state pattern

```typescript
let isRunning = false;

async function handleClick() {
  if (isRunning) return;
  isRunning = true;
  btn.textContent = '⏳ Working...';
  btn.disabled = true;
  try {
    await triggerJob({ THREAD_ID: selectedId });
    // If using wait:true with lastOutput, handle the result inline
    // If using WebSocket push, loadData() is called automatically by ws.onmessage
  } catch (err) {
    showError((err as Error).message);
    isRunning = false;
    btn.textContent = '↺ Retry';
    btn.disabled = false;
  }
}

// Called by WebSocket handler on completion
function onJobComplete() {
  loadData();
  isRunning = false;
  btn.textContent = '↺ Regen';
  btn.disabled = false;
}
```

---

## Quick Reference: Common Bash Operations from App

```typescript
// ✅ Write to linked SQLite — use /api/db/write (scoped, safe, no path knowledge needed)
await fetch('/api/db/write', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appId: APP_ID,
    sql: "UPDATE items SET status = ? WHERE id = ?",
    params: ['pending', id]   // always parameterize — never interpolate user input
  })
});

// Use /api/bash/run only for things /api/db/write can't do (e.g. unlinked databases, file ops)


// Check if a file exists or read its content
const { stdout } = await fetch('/api/bash/run', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ command: 'cat "$HOME/PAPR/jobs/JOB_ID/data/output.json"' })
}).then(r => r.json()) as { stdout: string };
```

**Security:** Never pass raw user input directly into the command string — sanitize first.

---

## Anti-Patterns (never do these)

```javascript
// ❌ Using bash job for Python script with API calls
create_job({ type: "bash", command: "pip3 install requests && python3 fetch.py" })
// → Use type: "python" for scripts. Bash jobs don't get venv or proper key injection.

// ❌ Putting ${KEY_NAME} in Python source code
// code/main.py: token = "${GITHUB_TOKEN}"
// → Substitution only works in the command string. Use argparse + CLI args.

// ❌ Using os.getenv for custom API keys
// Python: token = os.getenv('GITHUB_TOKEN')
// → Custom keys from Settings are injected into job env when declared in requiredKeys. Do not pass secrets as CLI args.

// ❌ Building a separate HTTP server job as a bridge
create_job({ name: "api-bridge", type: "node", command: "node server.js" })
// → fragile, port conflicts, completely unnecessary — use /api/jobs/run directly

// ❌ File-based IPC
window.__papr_write_file(...)    // doesn't exist
localStorage.setItem('req', id)  // agent process can't read browser localStorage

// ❌ Hitting an unknown path and concluding "no REST API" because you get HTML
fetch('/api/regen')  // → HTML (SPA catch-all) → wrong conclusion
// → test with curl bash first: curl http://localhost:18789/health

// ❌ Using webview_execute to test API calls
webview_execute({ script: "fetch('/api/jobs/run', ...)" })
// → webview_execute is for VISUAL INSPECTION only — edit app source files directly

// ❌ Node.js imports in browser JS
import Database from 'better-sqlite3'  // browser can't use Node modules

// ❌ Polling when WebSocket push is available
setInterval(() => fetch('/api/jobs/status/...'), 1000)
// → set up ws.onmessage listener instead
```

---

## Job Schema Patterns

### Write pattern (job side)
```python
import sqlite3, os

db_path = os.path.join(os.environ['JOB_DIR'], 'data', 'data.db')
conn = sqlite3.connect(db_path)
conn.execute('''CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT DEFAULT 'pending',
  result TEXT,
  updated_at TEXT
)''')
conn.execute("CREATE INDEX IF NOT EXISTS idx_status ON items(status)")
conn.commit()
```

### Read pattern (app side)
```typescript
// Always add ORDER BY + LIMIT for performance
const { rows } = await fetch('/api/db/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appId: APP_ID,
    sql: 'SELECT id, title, status, result FROM items WHERE status != ? ORDER BY updated_at DESC LIMIT 200',
    params: ['archived']
  })
}).then(r => r.json()) as { rows: Item[] };
```

---

## Key Checklist Before Shipping

- [ ] `list_apps` called before `create_app` (avoid duplicates)
- [ ] `list_jobs` called before `create_job` (avoid duplicates)
- [ ] `list_keys` called before jobs that need API keys
- [ ] Job type correct: `python` for scripts, `bash` for one-liners
- [ ] Python jobs with API keys: command uses `--token ${KEY_NAME}`, script uses argparse
- [ ] Design system loaded (`read_skill({ skillId: "preloaded-paprwork-design-system" })`)
- [ ] Data source linked: `attach_database` or `link_app_data_source` — verify with `read_app_data_sources`
- [ ] App uses APP_ID constant (not hardcoded string scattered everywhere)
- [ ] Job uses `JOB_DIR` env var for all file paths (not hardcoded `$PAPR_HOME/...` or legacy `~/Papr/...`)
- [ ] Button has loading/disabled state during job execution
- [ ] WebSocket listener set up for job completion push
- [ ] Error states handled in UI (not just happy path)
- [ ] Tested with `curl` or `bash` probe before wiring into app
