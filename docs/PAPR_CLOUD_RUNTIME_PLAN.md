# Papr Cloud Runtime — Architecture Plan

**Status:** Draft v10 (Phase 1 complete; 2A/3A/3B/3B-h complete; **3F Community done**; 3E Cloud App Host partial; **3E-b Mini-app backend edge execution done**; 3C/3D/4A/5 pending)  
**Created:** 2026-06-17  
**Updated:** 2026-07-09  
**Authors:** Amir + AI

---

## 1. Problem Statement

Paprwork today runs entirely on the user's Mac. All workspace data lives under the active org/namespace root (`$PAPR_HOME` = `~/Papr/orgs/{orgId}/namespaces/{nsId}/`), with runtime data in `~/.paprwork-v2/orgs/.../`. AI runs locally (or proxied through the memory server for LLM tokens only). This works for desktop but blocks three things:

1. **Server-side AI agents** (Cursor Composer, Claude Code, Codex) that need file access — the memory server can't see `$PAPR_HOME`.
2. **Web Paprwork** — a future browser-only client has no local `$PAPR_HOME` at all.
3. **Cloud jobs** — running scheduled jobs and mini-apps when the user's Mac is asleep.

We need a **provider-agnostic cloud workspace** so any AI (Cursor, Claude, GPT, Gemini, local Ollama) can operate on the same user data, and a **sandboxed runtime** where agentic tasks execute safely.

---

## 2. Design Principles

1. **ACL-first** — Every resource inherits the existing `Organization → Namespace → User` hierarchy. No new auth model.
2. **Git-native** — Workspace files live in GitHub repos. All clients (desktop, sandbox, web) use git. Agent CLIs already understand repos.
3. **Local-first, cloud-optional** — Desktop always works offline. Git repo is a sync target, not a blocking dependency.
4. **Web-first for web users** — Git repo *is* the source of truth when there's no desktop.
5. **Provider-agnostic** — Sync and workspace layers sit *below* the AI provider. Cursor, Claude, GPT all see the same repo.
6. **Ephemeral compute** — Sandboxes are disposable. Artifacts persist to git + cloud DB; containers are destroyed after each run.
7. **Secrets never in repos** — Credentials in a cloud vault (GCP Secret Manager), injected at runtime. Never committed to git.
8. **Shared control plane, isolated execution** — One multi-tenant cloud worker (24/7) schedules and orchestrates; sandboxes spin up only when a job or agent run is ready. No per-user 24/7 gateway VMs.
9. **Same mini-app contract everywhere** — Mini-apps always call same-origin `/api/db/*` and `/apps/*`. Turso credentials and vault secrets never reach the browser. Desktop, shared links, and Papr Web all use a backend proxy.

---

## 2b. Cloud Compute Model (Scheduler + Sandbox)

**Decision (2026-06-18):** Do NOT run a dedicated 24/7 cloud gateway per user (~$35–50/user/month). Use a **shared multi-tenant worker** plus **ephemeral sandboxes per execution**.

```
┌─────────────────────────────────────────────────────────────┐
│  Cloud Worker (24/7, shared, multi-tenant)                  │
│  • Auth + ACL (org → namespace → user)                      │
│  • Job scheduler tick (reads jobs.json from git per user)   │
│  • Turso push/pull orchestration (boundary sync)            │
│  • Sandbox provision / destroy                              │
│  • Run history, billing, WebSocket status to desktop        │
│  Cost: ~$200–500/mo total (not per user)                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ when job due or cloud run requested
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  GKE Agent Sandbox (ephemeral, per run)                       │
│  • git clone user's repo                                      │
│  • Turso pull → data.db                                       │
│  • inject vault keys                                          │
│  • run job (python/bash/agent)                                │
│  • Turso push + git commit                                    │
│  • destroy                                                    │
│  Cost: ~$0.01 per 5-min job                                   │
└─────────────────────────────────────────────────────────────┘
```

| When | Where jobs run |
|------|----------------|
| Mac awake, user active | **Local gateway** (today, $0 cloud compute) |
| Mac asleep, scheduled job due | **Cloud worker → sandbox** |
| Chat with Composer 2.5 | **Memory server → Cursor cloud** (Phase 2) |

**Tenant isolation (already mostly built):**

| Resource | Isolation |
|----------|-----------|
| Git repo | Per user (GitHub App + ACL) |
| Job `data.db` | Per user Turso DB |
| Secrets | Vault scoped by org/ns/user |
| Job execution | gVisor sandbox (never bare subprocess on shared worker) |

**Rejected alternatives:**

| Approach | Why not |
|----------|---------|
| 24/7 cloud gateway per user | $35–50/user/month at scale |
| Shared gateway running all user jobs as subprocesses | Security — arbitrary user code on shared OS |
| Turso sync for chats | PAPR Memory / Parse / MongoDB already handles chat |
| better-sqlite3 + background libsql sync | Tested — external writes do not replicate to Turso |
| SQLite ↔ PostgreSQL transform | Schema mismatch, job code breaks |

---

## 2c. Repository Ownership — What Lives Where

Cloud mini-apps touch **three codebases**. Each has a single responsibility; do not duplicate SQL validation or Turso table-prefix logic in Python.

| Repository | Role | Owns | Does NOT own |
|---|---|---|---|
| **`memory`** (FastAPI, Cloud Run) | **Control plane** | Auth/ACL, `/v1/cloud/repos/*`, `/v1/cloud/vault/*`, `/v1/cloud/databases/*`, app **publish metadata** (slug, visibility, share tokens), AI proxy, runtime orchestration (Phase 3C+) | Serving mini-app HTML, `/api/db/*` execution, SQL rewrite |
| **`paprwork-v2`** (TypeScript) | **App runtime + desktop** | Local gateway (`~/Papr`), CloudSync, TursoSyncBridge, **`appRuntime` module** (shared SQL + data-source routing), **Cloud App Host** deployable (`cloud-app-host.ts`), Electron UI | Long-lived Papr Web chat UI, Auth0 dashboard |
| **`papr-dev-platform`** (Next.js) | **Papr Web + dashboard** | Auth0 login, billing, settings, future browser chat UI | App runtime logic (proxies to Cloud App Host or embeds `apps.papr.ai`) |

### Data flow (all clients)

```
Mini-app JS  →  same-origin /api/db/* + /apps/*
                    │
        ┌───────────┴───────────┐
        │                         │
  Desktop Gateway          Cloud App Host          (future) Papr Web
  (paprwork-v2)            (paprwork-v2)           iframe or reverse proxy
  local SQLite             Turso via backend       → apps.papr.ai
        │                         │
        └───────────┬─────────────┘
                    ▼
            Memory Server /v1/cloud/*
            (tokens only — never sent to browser)
```

### Why runtime stays in TypeScript (paprwork-v2)

- Mini-app `/api/db/*` routes already exist in `src/gateway/index.ts` (~200 lines of validation + routing).
- Turso table prefix logic lives in `tursoSyncBridgeCore.ts` (`src_{jobId}__*`).
- Reimplementing in Python on `memory` would fork behavior and break "zero code change" for mini-apps.
- **Extract** shared logic into `src/gateway/services/appRuntime/` and run it in two modes:
  - `local` — filesystem + `better-sqlite3` (today's desktop gateway)
  - `cloud` — GitHub files + Turso (Cloud App Host on Cloud Run)

### Why publish metadata lives on `memory`

- Share tokens must be **hashed at rest** and never committed to git.
- ACL checks reuse existing `OptimizedAuthResponse` (org → namespace → user).
- Cloud App Host calls `POST /v1/cloud/apps/access/validate` server-to-server before executing DB ops.

---

## 2d. Cloud Mini-App Runtime (Product Layer)

**Problem:** Phase 1–3 built git sync, vault, and Turso provisioning, but mini-apps still only work when the desktop gateway is running locally.

**Solution:** A **Cloud App Host** — always-on, multi-tenant HTTP service that exposes the **same contract** as the desktop gateway:

| Route | Desktop backend | Cloud backend |
|---|---|---|
| `GET /apps/{appId}/*` | `$PAPR_HOME/apps/` | GitHub repo via `repos/token` |
| `GET /api/db/schema` | Local SQLite | Turso (prefixed tables) |
| `POST /api/db/query` | Local SQLite | Turso (server-held token) |
| `POST /api/db/write` | Local SQLite | Turso (server-held token) |
| `POST /api/db/exec` | Local SQLite | Turso DDL bootstrap |
| `POST /api/jobs/run` | Local JobsService | Memory `job-run` → GKE sandbox |
| `POST /api/app/backend/:action` | Local subprocess | **Cloud App Host** subprocess (handlers from git cache; vault via memory) |
| ~~`POST /api/bash/run`~~ | ~~Local gateway~~ | **Blocked for mini-apps** — use backend actions or jobs |

**Security rule (non-negotiable):** Browsers never receive Turso URLs, auth tokens, or vault secrets. All DB traffic goes through the backend proxy — same as desktop today.

**See:** `docs/MINI_APP_BACKEND_ARCHITECTURE.md` for the three-layer model (frontend / app backend / sandbox jobs).

### Shareable URLs

| URL pattern | Audience | Auth |
|---|---|---|
| `https://apps.papr.ai/{orgSlug}/{appSlug}` | Owner / team | Papr session or API key |
| Same URL + `?t={shareToken}` or `X-Papr-Share-Token` | Link visitors | Scoped token (read or read/write) |
| `https://dashboard.papr.ai/apps/...` (future) | Papr Web users | Auth0 session → memory server |

**One-click UX:** User enables "Cloud link" in Paprwork Settings (or auto-on when cloud sync healthy). No separate deploy pipeline — git push + Turso push must already be working.

### Access modes (three independent axes)

**Live app access** — who can open `apps.papr.ai/{slug}`:

| Axis | Values | Effect |
|---|---|---|
| `loginAccess` | `private` \| `team` \| `public` \| `none` | Papr login audience for live app |
| `externalLink` | `off` \| `read` \| `read_write` | Share-link visitors (when `loginAccess=none`) |

**Source code access** — who can fork/install into Paprwork:

| Axis | Values | Effect |
|---|---|---|
| `codeAccess` | `off` \| `install` | `install` = Community catalog + `install_cloud_app` (Edit the code). Source stays on papr-work git; never in browser. |

**Common combinations:**

| Goal | Settings |
|---|---|
| Community discovery + fork | `loginAccess=public`, `codeAccess=install` |
| Live web only (no code sharing) | `loginAccess=public`, `codeAccess=off` |
| Private link to live app | `loginAccess=none`, `externalLink=read` |
| Team app, no public listing | `loginAccess=team`, `codeAccess=off` |

**Share link API policy (updated 2026-07-09):**

| Route | Share link |
|-------|------------|
| `/api/db/*` | ✅ per ACL (`canRead` / `canWrite`) |
| `/api/app/backend/:action` | ✅ if `canRead` |
| `/api/jobs/run`, `/api/jobs/list` | ✅ if `canRead` (owner vault keys server-side) |
| `/api/bash/run` | ❌ blocked for mini-apps (local + cloud) |

Raw Turso credentials never reach the browser on any link type.

---

## 2e. Mini-App Three-Layer Runtime (2026-07-09)

Mini-apps follow a **frontend + backend + jobs** model (like Vercel + background workers):

```
Layer 1  apps/{appId}/*.ts, index.html     → browser → /api/db/*, /api/app/backend/*, /api/jobs/run
Layer 2  apps/{appId}/backend/*            → Cloud App Host edge subprocess (publish-time bundle)
Layer 3  Jobs/{jobId}/                     → GKE sandbox (agent, schedule, heavy ETL)
```

**Decisions:**

1. **Block `/api/bash/run` from mini-app clients** — agents use backend files or jobs; bash HTTP was a desktop shortcut that breaks on cloud.
2. **Allow `/api/jobs/run` on share links** — normal app behavior; anyone who can open the app can trigger linked sandbox jobs (rate-limited, audit-logged).
3. **App backend** — `backend/manifest.json` + handlers; bundled at publish (`backend/bundle.json`); executed on **Cloud App Host** at the edge (vault keys via memory only).
4. **Public API keys only in frontend** — vault secrets never in browser; optional `fetch()` to third parties with publishable keys only.

**Implementation:** See checklist in `docs/MINI_APP_BACKEND_ARCHITECTURE.md`.

---

## 3. What Lives in the Active Workspace (`$PAPR_HOME`)

```
~/Papr/
├── .active-workspace.json          ← pointer to active org/namespace
└── orgs/{organizationId}/
    └── namespaces/{namespaceId}/   ← $PAPR_HOME (active workspace root)
        ├── workspace/              # MEMORY.md, IDENTITY.md, BRAND.md, daily logs (5-50 KB)
        ├── apps/{appId}/           # mini-app source: HTML, JS, CSS (10-500 KB each)
        │   └── backend/            # app backend handlers + manifest.json (Phase 3E-b)
        ├── Jobs/{jobId}/
        │   ├── code/               # source files (1-100 KB each)        ← git-tracked
        │   ├── venv/               # Python virtual env (50-500 MB)      ← .gitignore
        │   ├── .venv/              # Alt Python venv location             ← .gitignore
        │   ├── node_modules/       # Node deps (50-500 MB)               ← .gitignore
        │   ├── logs/               # run logs (0-10 MB)                   ← .gitignore
        │   ├── .versions/          # version tracking                     ← .gitignore
        │   └── data/data.db        # SQLite (0-50 MB)                    ← cloud DB sync
        ├── data/                   # apps.json, jobs.json, settings.json, plans.db
        ├── bundles/                # portable bundle packages (future)
        └── documents/
```

Runtime chat/index data lives separately under `~/.paprwork-v2/orgs/{orgId}/namespaces/{nsId}/` (e.g. `chats.db`, exported `Chats/`).

**Four sync channels:**

| Data type | Sync mechanism | Why |
|---|---|---|
| Source code, config, workspace docs | **Git** (GitHub repo) | Agent CLIs speak git natively |
| Structured data (job DBs) | **Cloud DB** (Turso/libSQL) | Per-job SQLite replicas via boundary sync |
| Chat / plans | **PAPR Memory + git** | Not Turso in v1 |
| Credentials (API keys, tokens) | **Vault** (GCP Secret Manager) | Never in repos, injected at runtime |
| Runtime artifacts (venvs, logs, node_modules) | **Not synced** — rebuilt in sandbox | Too large, environment-specific |

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     CLIENTS                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Desktop    │  │  Web (future)│  │  Mobile      │  │
│  │  (Electron)  │  │  (browser)   │  │  (future)    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│     git + PAPR_API_KEY     │                  │          │
└─────────┼──────────────────┼──────────────────┼──────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────┐
│               MEMORY SERVER (FastAPI)                    │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ Auth/ACL │  │ AI Proxy │  │ Workspace│  │Runtime │  │
│  │ (exists) │  │ (exists) │  │ + Vault  │  │  Orch  │  │
│  │          │  │ OAI/Anth │  │  (new)   │  │ (new)  │  │
│  │          │  │ /Google/ │  │          │  │        │  │
│  │          │  │ Cursor   │  │          │  │        │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘  │
│       │              │             │             │        │
└───────┼──────────────┼─────────────┼─────────────┼────────┘
        │              │             │             │
        ▼              ▼             ▼             ▼
┌──────────────┐ ┌──────────┐ ┌───────────────────────────┐
│ MongoDB/Parse│ │ Upstream │ │     NEW INFRASTRUCTURE    │
│  Neo4j       │ │ LLM APIs │ │  ┌───────┐ ┌───────────┐ │
│  (exists)    │ │ (exists) │ │  │GitHub │ │GCP Secret │ │
│              │ │          │ │  │ Repos │ │ Manager   │ │
└──────────────┘ └──────────┘ │  └───────┘ └───────────┘ │
                              │  ┌───────┐ ┌───────────┐ │
                              │  │Turso  │ │ GKE Agent │ │
                              │  │(cloud │ │ Sandbox / │ │
                              │  │  DB)  │ │ Cloud Run │ │
                              │  └───────┘ └───────────┘ │
                              └───────────────────────────┘
```

### Four layers (two exist, two new):

| Layer | Status | Purpose |
|---|---|---|
| **Auth/ACL** | Exists | `OptimizedAuthResponse` with org/namespace/user scoping |
| **AI Proxy** | Exists | Token streaming to OpenAI/Anthropic/Google; add Cursor |
| **Workspace + Vault** | **New** | Git repos + Turso DBs + Secret Manager |
| **Runtime Orchestrator** | **New** | GKE Agent Sandbox / Cloud Run ephemeral compute, agent execution, writeback |

---

## 5. Workspace Sync via GitHub

### Ownership model — Users do NOT need a GitHub account

GitHub is **Papr's infrastructure**, not the user's. The same way users don't need a MongoDB account to use Papr Memory, they don't need a GitHub account for workspace sync.

```
┌─────────────────────────────────────────────────────────────────┐
│ What the USER sees              What ACTUALLY happens            │
│ ─────────────────               ──────────────────              │
│ "Sign up for Papr"         →    Server creates private repo     │
│ "Syncing workspace..."     →    Gateway does git pull/push      │
│ "Running in cloud..."      →    Sandbox clones from same repo   │
│ File appears in ~/Papr     →    Gateway pulled latest commit    │
│ Opens web.papr.ai          →    Web reads repo via GitHub API   │
│                                                                  │
│ User never sees GitHub. No GitHub OAuth. No GitHub onboarding.  │
│ It's a backend storage detail, like S3 backing a SaaS product.  │
└─────────────────────────────────────────────────────────────────┘
```

**Papr owns the GitHub Org** (`papr-work`). The memory server runs a **GitHub App** installed on this org. Repos are created/managed automatically — the user's `PAPR_API_KEY` is the only credential they ever touch.

| Step | Who acts | User involvement |
|---|---|---|
| Repo creation | Memory server via GitHub API | None — automatic on sign-up |
| Repo access | GitHub App issues installation tokens | None — memory server returns `cloneUrl` with embedded token |
| Desktop sync | Paprwork Gateway (background git) | Sees "Syncing..." status indicator |
| Sandbox clone | Runtime orchestrator (server-side) | None — happens inside GKE sandbox |
| Web access | Memory server proxies GitHub API | None — reads/writes go through `/v1/cloud/*` |

**Optional (separate feature):** If a user wants a cloud agent to work on *their own* GitHub repo (e.g., "refactor my startup's codebase"), that's the `repos[]` field in the runtime request. *That* requires GitHub OAuth — but it's a power-user feature, not part of workspace sync, and ships later.

### Why GitHub instead of GCS

| Factor | GCS (v1 plan) | GitHub (v2 plan) |
|---|---|---|
| Agent CLI compatibility | Custom hydration needed | Cursor/Claude/Codex speak git natively |
| Versioning | Custom generation tracking | Git commits (free, battle-tested) |
| Conflict resolution | Custom merge logic | Git merge strategies (solved problem) |
| Diffing | Custom file hash comparison | `git diff` |
| Sync protocol | Custom manifest/push/pull API | `git pull` / `git push` |
| Sandbox hydration | Download from GCS signed URLs | `git clone` (one command) |
| Web access | GCS signed URLs | GitHub API (well-documented) |
| Branching | Not possible | Sandboxes work on branches, merge back |
| CI/CD for cloud jobs | Custom scheduler | GitHub Actions (future) |
| Auth tokens | GCS signed URLs (15-min expiry) | GitHub App installation tokens |
| User needs account | No | **No** — Papr owns the org |

### GitHub App architecture

Memory server operates a **GitHub App** (`papr-workspace-bot`) installed on a Papr-owned GitHub Org (`papr-work`). Users never interact with GitHub directly.

### Repo scoping — three levels (mirrors memory ACLs)

Resources can be scoped at any level, just like memories:

```
GitHub Org: papr-work (owned by Papr, managed by memory server)
  │
  │  Repo naming: org-{orgId}-ns-{nsId}-u-{userId}
  │  Example:     org-y8d4h7yp3z-ns-vvpht1wnrb-u-mkcnhhg5kp
  │
  │  ORG-LEVEL (shared across entire organization)
  ├── org-{orgId}-shared/
  │     ├── templates/                    # org-wide app/job templates
  │     ├── data/shared-config.json       # org-wide settings
  │     └── .gitignore
  │
  │  NAMESPACE-LEVEL (shared across team/project)
  ├── org-{orgId}-ns-{nsId}-shared/
  │     ├── apps/{appId}/                 # team-shared mini-apps
  │     ├── jobs/{jobId}/code/            # team-shared jobs
  │     ├── data/apps.json                # team app registry
  │     └── .gitignore
  │
  │  USER-LEVEL (private to one user)
  ├── org-{orgId}-ns-{nsId}-u-{userId}/
  │     ├── workspace/
  │     │     ├── MEMORY.md               # personal memory
  │     │     ├── IDENTITY.md             # personal identity
  │     │     └── BRAND.md
  │     ├── apps/{appId}/                 # private mini-apps
  │     ├── Jobs/{jobId}/                 # private jobs (code, job.json, etc.)
  │     ├── data/
  │     │     ├── apps.json
  │     │     └── jobs.json
  │     └── .gitignore
  │
  └── org-{orgId}-ns-{nsId}-u-{userId2}/ # another user, isolated
```

### How sharing works in practice

| Scenario | Repo scope | Who can access |
|---|---|---|
| User's personal MEMORY.md, IDENTITY.md | `{org}--{ns}--{user}` | Only that user |
| User's private mini-app | `{org}--{ns}--{user}` | Only that user |
| Team's shared dashboard app | `{org}--{ns}--shared` | All users in that namespace |
| Team's shared scraper job | `{org}--{ns}--shared` | All users in that namespace |
| Org-wide job templates | `{org}--shared` | All namespaces in the org |
| Team's shared API credentials | Vault: `{org}--{ns}--shared` | All users in that namespace |
| User's personal API keys | Vault: `{org}--{ns}--{user}` | Only that user |

**Default:** Everything starts as user-scoped (private). Users/admins explicitly share to namespace or org level. Same mental model as Google Drive: files are private until you share them.

This applies uniformly to all resource types:
- **Repos** — user/namespace/org repos
- **Databases** — user/namespace/org Turso databases
- **Vault keys** — user/namespace/org secrets
- **Runtime sessions** — run against any repo the caller has access to

### `.gitignore` (replaces server-side sync rules):

```gitignore
# Runtime — rebuilt per environment
**/venv/
**/node_modules/
**/__pycache__/
**/dist/

# SQLite — synced via Turso, not git
**/*.db
**/*.db-wal
**/*.db-shm

# Logs — ephemeral
**/logs/

# Secrets — never in git
.env
*.pem
*.key
```

### ACL enforcement

```
API Key Type          →   Repo Access
──────────────────────────────────────────────────────────────────
Namespace-scoped key  →   {org}--{bound_ns}--{user}/          (own user repo)
                          {org}--{bound_ns}--shared/           (team shared repo)
Org-scoped key        →   {org}--{any_ns}--{user}/            (any user in org)
                          {org}--{any_ns}--shared/             (any team shared)
                          {org}--shared/                       (org shared)
Legacy key            →   _legacy--{developer_id}/
```

Identical to memory route ACLs. Memory server calls `resolve_namespace_id()` to determine which repos the caller can access, then issues GitHub App installation tokens scoped to those repos.

### Cloud API — `/v1/cloud/*`

All cloud infrastructure routes live under `/v1/cloud/`. Same auth as all other routes (`X-API-Key: PAPR_API_KEY`).

#### `POST /v1/cloud/repos/token`

Returns a short-lived GitHub App installation token scoped to the requested repo(s).

```json
// Request
{
  "scope": "user",
  "namespace_id": "optional-override-for-org-key"
}

// Response
{
  "repos": [
    {
      "scope": "user",
      "repoUrl": "https://github.com/papr-work/org-orgA-ns-nsB-u-user123",
      "cloneUrl": "https://x-access-token:ghs_xxx@github.com/papr-work/org-orgA-ns-nsB-u-user123.git"
    }
  ],
  "token": "ghs_xxxxxxxxxxxxxxxxxxxx",
  "expiresAt": "2026-06-17T01:00:00Z"
}
```

The `scope` parameter controls which repos are accessible:
- `"user"` (default) — user's private repo
- `"namespace"` — team shared repo + user repo
- `"org"` — org shared repo + team repo + user repo
- `"all"` — all repos the caller's API key can access

Token expires in 1 hour. Memory server creates the repo on first call if it doesn't exist.

#### `POST /v1/cloud/repos/init`

Initialize a new repo with default structure.

```json
// Request
{
  "scope": "user",
  "namespace_id": "optional",
  "template": "default"
}

// Response
{
  "repoUrl": "https://github.com/papr-work/org-orgA-ns-nsB-u-user123",
  "created": true,
  "defaultBranch": "main"
}
```

#### `POST /v1/cloud/vault/sync` — see §7

#### `GET /v1/cloud/vault/keys` — see §7

#### `POST /v1/cloud/databases/list` — see §6

#### `POST /v1/cloud/databases/token` — see §6

#### `POST /v1/cloud/apps/publish` — see §2d (Phase 3E)

Register slug + visibility; returns `shareUrl` and one-time `shareToken` for link modes.

#### `GET /v1/cloud/apps/publish/{appId}` — owner reads publish config

#### `DELETE /v1/cloud/apps/publish/{appId}` — disable cloud link

#### `POST /v1/cloud/apps/access/validate` — validate owner login or share token (used by Cloud App Host)

#### `GET /v1/cloud/apps/community` — list public apps with `codeAccess=install` (Community catalog)

#### `POST /v1/cloud/apps/install` — clone publisher's app subtree from papr-work git (fork or track)

#### `POST /v1/cloud/apps/changes` — submit change request from fork → upstream owner

#### `GET /v1/cloud/apps/changes/incoming` — owner lists pending change requests

#### `POST /v1/cloud/apps/changes/{id}/approve|reject` — owner resolves request (v1: metadata only; git merge TBD)

#### `POST /v1/cloud/runtime/sessions/stream` — see §8

### Client sync flows

**Desktop (Electron/Gateway):**
```
1. POST /v1/cloud/repos/token → { cloneUrl, token }
2. If first time: git clone {cloneUrl} ~/Papr
3. On file change: git add + git commit + git push (background, debounced)
4. On app start: git pull (fast-forward)
5. Before cloud agent run: git push (ensure latest)
```

**Sandbox (GKE Agent Sandbox):**
```
1. Memory server calls POST /v1/cloud/repos/token (server-side)
2. git clone {cloneUrl} /workspace (user repo)
3. Optionally also clone namespace shared repo for team resources
4. Agent runs, makes changes
5. git add + git commit + git push
6. Desktop pulls changes on next sync
```

**Web (future):**
```
1. POST /v1/cloud/repos/token → { token }
2. Use GitHub API with token to list/read/write files
3. Or: use isomorphic-git in browser for full git
```

---

## 6. Cloud Database — Turso (libSQL)

### Why Turso

| Factor | Raw SQLite in git | Managed PostgreSQL | Turso (libSQL) |
|---|---|---|---|
| Wire-compatible with SQLite | N/A (binary) | No (schema translation) | **Yes** |
| Existing queries work | N/A | Rewrite needed | **Drop-in** |
| Embedded replicas | No | No | **Yes** (local SQLite that auto-syncs) |
| Per-database pricing | No | Per-instance | **Per-DB** (fits per-job model) |
| Offline reads | If committed | No | **Yes** (local replica) |
| WAL conflicts | Breaks git | N/A | **Handled by libSQL** |

Turso is the natural fit because every job already has its own `data.db`. Instead of fighting with SQLite WAL locks in git, each job's DB becomes a Turso database with an embedded local replica.

### Architecture

```
Desktop (~/Papr)                    Cloud
─────────────────                   ─────
jobs/{jobId}/data/data.db           Turso DB: papr-{org}--{ns}--{user}--{jobId}
  │ (embedded libSQL replica)           │
  │                                     │
  └──── auto-sync (bidirectional) ──────┘
                                        │
                    ┌───────────────────┤
                    │                   │
              Sandbox reads/writes    Web reads/writes
              via Turso URL           via Turso HTTP API
```

### Which databases sync

| Database | Location | Sync to Turso | Why |
|---|---|---|---|
| Job data DBs | `$PAPR_HOME/Jobs/{id}/data/data.db` | **Yes** | Mini-apps + jobs; cloud sandboxes need this |
| Chat DB | `~/.paprwork-v2/chats.db` | **No** | PAPR Memory / Parse / MongoDB already syncs chat |
| Plans DB | `$PAPR_HOME/data/plans.db` | **No** (v1) | Local + git `data/`; add later if web needs it |
| Code index DB | `~/.paprwork-v2/code-index.db` | No | Device-specific, rebuilt locally |
| App state DB | `~/.paprwork-v2/app-state.db` | No | Device-specific UI state |

### Turso database naming (implemented)

```
Org: papr-cloud (Turso organization)

Per-user database (v1 implementation):
  database name: "data"
  tables: src_{jobId}__{tableName}   # prefixed staging in shared user DB

Legacy plan text referenced per-job Turso DBs — rejected at implementation
time to avoid org database limits and simplify Cloud App Host routing.
```

### Database API (memory server)

#### `POST /v1/cloud/databases/list`

List user's cloud databases.

```json
// Response (v1: job databases only)
{
  "databases": [
    { "name": "job-abc123", "tursoUrl": "libsql://p-...", "sizeBytes": 524288 }
  ]
}
```

#### `POST /v1/cloud/databases/token`

Get a short-lived auth token for a specific Turso database.

```json
// Request
{ "database": "job-abc123" }

// Response
{
  "tursoUrl": "libsql://papr--orgA--nsB--user123--job-abc123.turso.io",
  "authToken": "eyJ...",
  "expiresAt": "2026-06-17T02:00:00Z"
}
```

### Desktop integration — TursoSyncBridge (boundary sync)

**Do NOT** replace `better-sqlite3` with `@libsql/client` for job DBs. Tested 2026-06-18:
external `better-sqlite3` / `sqlite3` writes are **not** replicated by libsql `sync()`.

**Pattern (verified in `scripts/test-turso-job-sync.mjs`):**

```
Push (desktop → Turso):
  1. Job writes data.db via better-sqlite3 (unchanged)
  2. TursoSyncBridge reads all tables from local SQLite
  3. Upserts to Turso via libsql staging replica
  4. Triggered: before cloud agent run, after local job completes

Pull (Turso → desktop):
  1. libsql sync() into local file
  2. better-sqlite3 reads normally
  3. Triggered: on startup, after cloud run completes
```

Job code (`sqlite3.connect("data/data.db")`) never changes.

### Sandbox integration — hydrate/run/sync pattern

User job code uses standard `sqlite3` (Python) or `better-sqlite3` (Node) — it connects to a file on disk. That code should **never need to change** for cloud execution.

The runtime orchestrator handles sync as bookends around the job using **TursoSyncBridge** (full table copy), not naive libsql `sync()` alone — external SQLite writes do not auto-replicate.

```
┌─────────────────────────────────────────────────────────────┐
│ BEFORE JOB (orchestrator)                                    │
│   1. TursoSyncBridge.pull(jobId) → hydrate data.db           │
│      (libsql sync + table copy into job SQLite file)         │
│   2. Real SQLite file on disk, no libsql lock held           │
├─────────────────────────────────────────────────────────────┤
│ JOB RUNS (user's code — zero changes)                        │
│   3. import sqlite3                                          │
│      conn = sqlite3.connect("data/data.db")  ← normal file  │
│      cursor.execute("INSERT INTO tweets ...") ← normal SQL  │
│      conn.close()                                            │
├─────────────────────────────────────────────────────────────┤
│ AFTER JOB (orchestrator)                                     │
│   4. TursoSyncBridge.push(jobId) → read tables, upsert Turso │
│   5. Desktop TursoSyncBridge.pull on wake / after cloud run  │
└─────────────────────────────────────────────────────────────┘
```

**Implementation:** Same logic as `scripts/test-turso-job-sync.mjs` (Node/Electron) and Python equivalent in sandbox (`papr_db_sync.py`).

Orchestrator hydrate/sync script (runs in sandbox before/after job):

```python
# papr_db_sync.py — injected into sandbox by orchestrator
# Uses TursoSyncBridge table-copy pattern (NOT sync()-only)
import sqlite3, libsql_experimental as libsql, sys, os

TURSO_URL = os.environ["TURSO_URL"]
TURSO_TOKEN = os.environ["TURSO_AUTH_TOKEN"]
DB_PATH = sys.argv[1]

def pull():
    """Hydrate local data.db from Turso (table copy)."""
    # 1. libsql sync into staging replica
    # 2. DROP/CREATE + INSERT all tables into DB_PATH
    ...

def push():
    """Push local data.db changes to Turso (table copy)."""
    # 1. Read all tables from DB_PATH via sqlite3
    # 2. Upsert into libsql staging replica → sync()
    ...

if sys.argv[2] == "pull":
    pull()
elif sys.argv[2] == "push":
    push()
```

```bash
# Orchestrator wraps job execution:
python3 papr_db_sync.py /workspace/jobs/{id}/data/data.db pull   # BEFORE
python3 code/main.py                                              # JOB (unchanged)
python3 papr_db_sync.py /workspace/jobs/{id}/data/data.db push    # AFTER
```

### Access patterns by client

| Client | How it accesses data | Code changes needed |
|---|---|---|
| **Desktop** | `better-sqlite3` on local file + TursoSyncBridge push/pull at boundaries | **None** for job code; bridge is gateway-only |
| **Sandbox** | Standard `sqlite3` on file; orchestrator pull/push bookends | **None** — job code unchanged |
| **Web / shared links** | Same-origin `/api/db/*` on Cloud App Host → Turso (backend proxy) | **None** — iframe or embed `apps.papr.ai` |
| **Agent jobs** | Same as sandbox — standard SQLite in container | **None** |

---

## 7. Credentials Vault — GCP Secret Manager

### Why a cloud vault

Desktop stores credentials in macOS Keychain (`CustomKeysService`). Cloud sandboxes and web clients can't access the Keychain. We need a cloud-side mirror.

### Architecture

```
Desktop                          Memory Server                    Sandbox
────────                         ─────────────                    ───────
macOS Keychain                   GCP Secret Manager               Env vars
  │                                │                                │
  │ POST /v1/cloud/vault/sync    │                                │
  ├──────────────────────────────►│                                │
  │ { keys: [{name, value}] }    │ Encrypted at rest              │
  │                              │ ACL-scoped per user             │
  │                              │                                │
  │                              │  provision_sandbox()            │
  │                              ├────────────────────────────────►│
  │                              │  inject as env vars             │
  │                              │  NEON_DB_URL=...               │
  │                              │  POSTHOG_API_KEY=...           │
```

### Secret naming in GCP Secret Manager

```
projects/papr-cloud/secrets/
  vault--{org_id}--{ns_id}--{user_id}--NEON_DB_URL
  vault--{org_id}--{ns_id}--{user_id}--POSTHOG_API_KEY
  vault--{org_id}--{ns_id}--{user_id}--OPENAI_API_KEY
```

### Vault API (memory server)

#### `POST /v1/cloud/vault/sync`

Desktop pushes custom keys to the cloud vault. Encrypted in transit (HTTPS) and at rest (Secret Manager). Idempotent — updates existing, creates new, deletes removed.

```json
// Request
{
  "scope": "user",
  "keys": [
    { "name": "NEON_DB_URL", "value": "postgres://..." },
    { "name": "POSTHOG_API_KEY", "value": "phc_..." }
  ]
}

// Response
{
  "synced": 2,
  "created": ["POSTHOG_API_KEY"],
  "updated": ["NEON_DB_URL"],
  "deleted": []
}
```

#### `GET /v1/cloud/vault/keys`

List key names (no values) — for UI display and sandbox configuration.

```json
// Response
{
  "keys": [
    { "name": "NEON_DB_URL", "syncedAt": "2026-06-17T00:30:00Z" },
    { "name": "POSTHOG_API_KEY", "syncedAt": "2026-06-17T00:30:00Z" }
  ]
}
```

#### `POST /v1/cloud/vault/resolve` (server-side only)

Server-side only (not exposed to clients). Runtime orchestrator calls this to get values for sandbox injection.

```python
async def resolve_keys(auth: OptimizedAuthResponse, key_names: list[str]) -> dict[str, str]:
    """Read secrets from GCP Secret Manager for sandbox env var injection."""
    prefix = f"vault--{auth.organization_id}--{auth.namespace_id}--{auth.end_user_id}"
    return {name: access_secret(f"{prefix}--{name}") for name in key_names}
```

### Desktop sync trigger

```typescript
// Gateway: sync keychain to vault on key changes
async function syncKeychainToVault(paprApiKey: string): Promise<void> {
  const allKeys = await customKeysService.listKeys();
  const keyValues = await Promise.all(
    allKeys.map(async (name) => ({
      name,
      value: await customKeysService.getKey(name),
    }))
  );

  await fetch(`${PAPR_API_BASE}/v1/cloud/vault/sync`, {
    method: "POST",
    headers: { "X-API-Key": paprApiKey },
    body: JSON.stringify({ keys: keyValues }),
  });
}
```

Trigger points:
- After user adds/updates/deletes a key in Settings
- Before a cloud agent run (ensure latest keys available)
- On app startup (periodic full sync)

### Security

| Concern | Mitigation |
|---|---|
| Key values in transit | HTTPS only |
| Key values at rest | GCP Secret Manager encryption (AES-256) |
| Cross-tenant access | Secret names include org/ns/user; ACL check before access |
| Sandbox access scope | Only requested keys injected; not all vault keys |
| Key lifetime in sandbox | Env vars only — sandbox destroyed after run |
| Vault API auth | Same `PAPR_API_KEY` + `OptimizedAuthResponse` |
| Key values in LLM context | Never — injected as `${KEY_NAME}`, resolved server-side |

---

## 8. Runtime Orchestrator — GCP (GKE Agent Sandbox + Cloud Run)

### Why GCP native compute

The memory server already runs on GCP (Cloud Run). Using GCP's own sandbox infrastructure keeps everything on one platform, one bill, one IAM model — and eliminates a third-party vendor dependency.

| Factor | E2B | Daytona | GKE Agent Sandbox | Cloud Run Ephemeral |
|---|---|---|---|---|
| Startup time | ~1-3s | ~5-15s | **Sub-second** | ~2-5s |
| Container isolation | Yes | Yes (container) | **Yes (gVisor kernel)** | Yes (gVisor) |
| Networking | Configurable | Configurable | **Configurable** | Full |
| Languages | Any | Any | **Any** (full container) | Any |
| Git clone built-in | No | Yes | No (image-level) | No |
| Scale | Vendor limits | Self-hosted | **300 sandboxes/sec/cluster** | Auto-scale |
| Open source | No | Yes | Partially (GKE/gVisor) | No |
| Vendor lock-in | High | None | Medium (GCP) | Medium (GCP) |
| Already on GCP | N/A | No | **Yes** | **Yes** |
| CUD discounts | No | No | **Yes** | **Yes** |
| Free tier | No | No | **Yes** (50 vCPU-hrs/mo) | **Yes** (2M req/mo) |

**Decision:** GKE Agent Sandbox for full sandbox execution (jobs, agents). Cloud Run ephemeral for lightweight tasks (Phase 2 Cursor, quick scripts).

**Why this over Daytona:**
1. **Already on GCP** — memory server is on Cloud Run, same project, same IAM, same billing
2. **Sub-second starts** — GKE Agent Sandbox provisions in <1s (Daytona: 5-15s)
3. **Scale proven** — 300 sandboxes/sec/cluster, battle-tested at Google scale
4. **Unified billing** — Compute Unit SKU at $0.085/vCPU-hr, CUDs apply
5. **No operational overhead** — GCP manages sandbox infra, no Daytona cluster to maintain
6. **gVisor kernel isolation** — stronger isolation than container-level (same tech powers Cloud Run)

### Two compute tiers

| Tier | Service | Use case | Startup | Networking | Lifecycle |
|---|---|---|---|---|---|
| **Lightweight** | Cloud Run ephemeral | Cursor Phase 2, quick agent tasks | ~2-5s | Full | Request-scoped (destroyed after) |
| **Full sandbox** | GKE Agent Sandbox | Jobs, multi-step agents, long-running | Sub-second | Configurable | Session-scoped (TTL up to 14 days) |

**Phase 2** uses Cloud Run (already deployed, minimal new infra). **Phase 3** adds GKE Agent Sandbox for full job execution with persistent state.

### Session lifecycle

```
1. Auth + ACL check
   └─ OptimizedAuthResponse → resolve_workspace_scope()
   └─ Get GitHub App token for user's repo

2. Ensure workspace is pushed
   └─ Desktop client confirms git push before cloud run
   └─ Or: memory server checks latest commit timestamp

3. Provision sandbox
   └─ GKE: create sandbox from Papr base image
   └─ git clone user's repo into /workspace
   └─ Install dependencies (pip install, npm install)
   └─ Sub-second sandbox creation + clone time

4. Inject credentials
   └─ Resolve keys from GCP Secret Manager
   └─ Inject as sandbox env vars via GKE API
   └─ Provider API key (CURSOR_API_KEY, etc.) from server env

5. Connect to Turso databases
   └─ Resolve Turso URLs + tokens for user's databases
   └─ Inject as TURSO_URL + TURSO_AUTH_TOKEN env vars

6. Run agent
   └─ Execute agent CLI in sandbox (cursor, claude, codex, generic)
   └─ Stream stdout/stderr → SSE events to client
   └─ Provider-specific CLI → normalized RuntimeStreamEvent format

7. Writeback
   └─ Agent commits changes to git (within sandbox)
   └─ git push (back to user's repo)
   └─ Turso data already synced (direct connection)

8. Cleanup
   └─ Destroy GKE sandbox (or let TTL expire)
   └─ Revoke temporary tokens
   └─ Fire Stripe meter events

9. Client sync
   └─ Desktop: git pull → local ~/Papr updated
   └─ Turso embedded replica auto-syncs
   └─ Web: GitHub API / Turso HTTP already current
```

### Sandbox base image

```dockerfile
# ghcr.io/papr-ai/workspace:latest
FROM python:3.11-slim

# Common runtimes
RUN apt-get update && apt-get install -y git curl nodejs npm && rm -rf /var/lib/apt/lists/*

# Agent CLIs (pre-installed for fast startup)
RUN pip install cursor-sdk libsql-experimental
RUN npm install -g @anthropic-ai/claude-code

# Turso sync helper
COPY papr_db_sync.py /usr/local/bin/papr_db_sync.py

WORKDIR /workspace
```

Jobs requiring specific Python/Node versions or additional dependencies use `requirements.txt` / `package.json` from the repo — installed during the clone step.

### Unified Runtime API

`POST /v1/cloud/runtime/sessions/stream` — single endpoint for all cloud agent runs.

```json
// Request
{
  "chatId": "chat-abc123",
  "prompt": "Refactor the jobs scheduler",
  "provider": "cursor",
  "model": "composer-2.5",
  "agentId": "optional-for-resume",
  "runtime": "cloud",
  "tier": "sandbox",
  "keyNames": ["NEON_DB_URL", "POSTHOG_API_KEY"]
}
```

The `tier` field selects compute:
- `"ephemeral"` — Cloud Run (lightweight, Phase 2)
- `"sandbox"` (default) — GKE Agent Sandbox (full, Phase 3+)

This **replaces** `POST /v1/ai/cursor/runs/stream` with a provider-agnostic version.

### SSE event contract (provider-agnostic)

Same shape already defined in `CursorRunStreamEvent`, applies to all providers:

```typescript
interface RuntimeStreamEvent {
  type:
    | "session-meta"    // first event: sessionId, agentId, provider
    | "text-delta"
    | "reasoning-start"
    | "reasoning-delta"
    | "reasoning-end"
    | "tool-call"
    | "tool-result"
    | "error"
    | "done";
  // fields per type (same as existing CursorRunStreamEvent)
}
```

---

## 9. ACL Model (Reuse Existing)

The memory server already enforces `Organization → Namespace → User` at every API boundary via `OptimizedAuthResponse` and `resolve_namespace_id()`. Cloud resources follow the exact same model.

### Three levels of resource scoping

| Level | Naming pattern | Who can access | Use case |
|---|---|---|---|
| **User** | `{org}--{ns}--{user}` | Only that user | Personal workspace, private apps, personal keys |
| **Namespace** | `{org}--{ns}--shared` | All users in that namespace | Team apps, shared jobs, team credentials |
| **Organization** | `{org}--shared` | All namespaces in the org | Org templates, org-wide config |

### How ACLs apply to each resource type

| Resource | User-scoped | Namespace-scoped | Org-scoped |
|---|---|---|---|
| **Git repo** | `{org}--{ns}--{user}` | `{org}--{ns}--shared` | `{org}--shared` |
| **Turso DB** | `papr--{org}--{ns}--{user}--{db}` | `papr--{org}--{ns}--shared--{db}` | `papr--{org}--shared--{db}` |
| **Vault key** | `vault--{org}--{ns}--{user}--{key}` | `vault--{org}--{ns}--shared--{key}` | `vault--{org}--shared--{key}` |
| **Sandbox** | Clones user repo | Clones user + namespace repos | Clones user + ns + org repos |

### Access rules (identical to memory routes)

| API key type | Resource access | Enforced by |
|---|---|---|
| Namespace-scoped key | User + namespace-shared resources within bound namespace | `resolve_namespace_id()` raises `NamespaceAuthorizationError` if mismatch |
| Org-scoped key | User + namespace + org-shared resources in any namespace | Caller may specify `namespace_id` |
| Legacy key | `_legacy--{developer_id}` prefixed resources only | `is_legacy_auth=True` path |

### Sharing flow

```
Default: Everything is user-scoped (private).

To share an app with the team:
  1. Move app from user repo to namespace-shared repo (git)
  2. Update apps.json in namespace-shared repo
  3. Team members see it on next sync

To share a credential with the team:
  1. POST /v1/cloud/vault/sync { scope: "namespace", keys: [...] }
  2. Key stored as vault--{org}--{ns}--shared--{key}
  3. Any team member's sandbox can access it
```

**Key insight:** No new ACL logic. Every `/v1/cloud/*` route calls `resolve_namespace_id()` to determine which scopes the caller can access, then issues tokens accordingly.

---

## 10. How This Enables Each Scenario

### Scenario A: Desktop + Cursor Composer (near-term)

```
User selects Composer 2.5 in Paprwork
  → Gateway: git push (sync latest to GitHub)
  → Gateway: vault sync (sync keys to Secret Manager)
  → POST /v1/cloud/runtime/sessions/stream { provider: "cursor", runtime: "cloud" }
  → Phase 2: Memory server clones repo to Cloud Run ephemeral disk
  → Phase 3+: Memory server provisions GKE sandbox from user's repo
  → Inject CURSOR_API_KEY + user's custom keys as env vars
  → Run cursor-sdk in sandbox, stream SSE back
  → Agent commits changes, git push
  → Desktop: git pull → ~/Papr updated
```

### Scenario B: Desktop + Claude/GPT (existing, no change)

```
User selects Claude in Paprwork
  → Gateway uses AI SDK with local tools (bash, filesystem, browser)
  → ~/Papr is local, full access, no sync needed
  → Same as today — zero changes
```

### Scenario C: Web Paprwork (future)

```
User opens web.papr.ai, logs in with Papr
  → GitHub repo is source of truth (files via GitHub API)
  → Turso is source of truth (data via HTTP API)
  → POST /v1/cloud/runtime/sessions/stream { provider: "anthropic", runtime: "cloud" }
  → Sandbox clones repo, connects Turso, runs agent
  → Changes committed and pushed
  → Web UI reflects changes immediately
  → No desktop needed
```

### Scenario D: Cloud scheduled jobs (future)

```
Cron trigger fires on memory server
  → Read job config from GitHub repo (via API)
  → Provision GKE sandbox from repo
  → Inject credentials from vault
  → Run job code (Python/Node/agent)
  → Data written to Turso (accessible everywhere)
  → Push code changes to repo if any
  → Destroy sandbox
  → Fire Stripe meter events + notification to user's devices
```

---

## 11. Job Parity: Local vs Cloud

A job in a sandbox runs the **exact same code** as a job on the user's Mac. No rewrite, no deploy step. The user tests locally, enables the schedule, and it runs in the cloud.

### Side-by-side comparison

```
LOCAL (Desktop)                           CLOUD (Sandbox)
───────────────                           ───────────────
1. JobsService reads job.json             1. Orchestrator reads job.json
   from $PAPR_HOME/Jobs/{id}/                    from git repo /workspace/jobs/{id}/

2. CommandJobExecutor spawns process      2. GKE sandbox runs process in container

3. Custom keys from Keychain              3. Custom keys from GCP Secret Manager
   via ${KEY_NAME} substitution              injected as env vars (same names)

4. python3 code/main.py                   4. python3 code/main.py
   --db '${NEON_DB_URL}'                     (NEON_DB_URL is in env)

5. SQLite via better-sqlite3              5. Standard sqlite3 on local file
   on $PAPR_HOME/Jobs/{id}/data/data.db          (orchestrator hydrates from Turso
                                              before, pushes back after — §6)

6. pip install from requirements.txt      6. pip install from requirements.txt
   in local venv                             in sandbox (fresh install)

7. Logs to $PAPR_HOME/Jobs/{id}/logs/         7. Logs captured by orchestrator

8. Exit code → JobsService                8. Exit code → orchestrator
   updates jobs.json                         pushes status to git + notifies
```

### What's identical (user's code doesn't change)

| Concern | Local | Sandbox | Same? |
|---|---|---|---|
| Source files | `$PAPR_HOME/Jobs/{id}/code/` | `/workspace/jobs/{id}/code/` | **Yes** (git) |
| `job.json` config | `$PAPR_HOME/Jobs/{id}/job.json` | `/workspace/jobs/{id}/job.json` | **Yes** (git) |
| SQL queries | `SELECT * FROM tweets WHERE ...` | Same SQL on same `.db` file | **Yes** (orchestrator hydrates/pushes via Turso) |
| Dependencies | `requirements.txt` / `package.json` | Same files | **Yes** (git) |
| Python/Node version | Local install | Sandbox image | **Matched** via devcontainer.json |
| Exit code contract | 0 = success, 1+ = failure | Same | **Yes** |

### How custom keys resolve in each environment

Locally, `CommandJobExecutor` does string substitution in the command before spawning — Keychain values aren't env vars, so `${KEY_NAME}` is replaced with the literal value.

In a sandbox, vault values are injected as **real env vars**. The `${KEY_NAME}` syntax already looks like shell variable expansion, so it works natively:

```bash
# Local: CommandJobExecutor substitutes before spawn
python3 code/main.py --db 'postgres://user:pass@host/db'   # literal value

# Sandbox: shell expands env var naturally
python3 code/main.py --db "$NEON_DB_URL"                    # env var
```

Both approaches work with the same `job.json` command: `python3 code/main.py --db '${NEON_DB_URL}'`

For code that reads keys via argparse (`sys.argv`), local substitution provides the value as an argument. For code that reads `os.environ`, the sandbox has the value as an env var. The runtime orchestrator supports both: it does `${KEY_NAME}` → value substitution in the command string AND sets the keys as env vars.

### Scheduled cloud jobs — works while Mac is asleep

```
User creates job locally:
  create_job({ name: "Weekly Brief", type: "python",
               command: "python3 code/brief.py --api '${POSTHOG_API_KEY}'",
               schedule: { enabled: true, cron: "0 7 * * 1" } })

  → Tests locally: run_job → works, data in data.db ✅
  → Syncs to cloud: git push (auto), vault sync, Turso replica sync

Monday 7am (Mac is asleep):
  → Memory server cron reads job config from git repo
  → Provisions GKE sandbox from user's repo
  → Injects POSTHOG_API_KEY from vault as env var
  → Connects to Turso DB for this job
  → Runs: python3 code/brief.py --api "$POSTHOG_API_KEY"
  → Data written to Turso ← same SQL as local
  → Sandbox destroyed
  → Push notification: "Weekly Brief completed ✅"

User opens Mac later:
  → Turso embedded replica auto-syncs data.db
  → Mini-app dashboard shows fresh data immediately
  → git pull brings any code changes (if agent job modified files)
```

**Zero-deploy workflow:** Write → test locally → enable schedule → it just runs in the cloud.

---

## 12. Billing

### GCP Compute Unit pricing (effective June 17, 2026)

GCP is transitioning Runtime, Code Execution Sandbox, Sessions, and Memory Bank to unified SKUs:

| SKU | Rate | What it covers |
|---|---|---|
| **Compute Unit** | $0.085/vCPU-hr | Sandbox vCPU time (consolidated from $0.0864) |
| **Memory** | $0.009/GiB-hr | Sandbox RAM |
| **Sessions** | $0.25/1K events | Session state storage |

**Free tier (per month):** 180,000 vCPU-seconds (50 hours) + 360,000 GiB-seconds (100 hours).

**Cost per sandbox session (typical):**
- 2 vCPU × 5 min = $0.014 per session
- 10,000 sessions/month = ~$140/month
- With CUDs (Committed Use Discounts): 20-30% less

### New operation types (add to `MemoryOperationType`)

```python
# Workspace operations
WORKSPACE_TOKEN = "workspace_token"                 # 0 (included in plan)
WORKSPACE_INIT = "workspace_init"                   # 1 mini

# Vault operations  
VAULT_SYNC = "vault_sync"                           # 0 (included in plan)
VAULT_LIST_KEYS = "vault_list_keys"                 # 0

# Database operations
DATABASE_TOKEN = "database_token"                   # 0 (included in plan)
DATABASE_CREATE = "database_create"                 # 1 mini

# Runtime operations
RUNTIME_SESSION = "runtime_session"                 # 1 premium per session
RUNTIME_COMPUTE_UNIT = "runtime_compute_unit"       # metered — GCP Compute Unit pass-through
```

### New Stripe meters

| Meter | Unit | Pricing (suggested) |
|---|---|---|
| `papr_workspace_repos` | repo-month | Free (1 per user, included) |
| `papr_turso_databases` | DB-month | Free up to 5 DBs, then $1/DB |
| `papr_turso_storage` | GB-month | Free up to 500 MB, then $0.50/GB |
| `papr_vault_keys` | key-month | Free up to 20 keys |
| `papr_compute_units` | vCPU-hour | $0.10/vCPU-hr (GCP cost $0.085 + Papr margin) |

LLM tokens stay on existing `papr_premium_interactions` / `papr_mini_interactions` meters.

### Cost comparison vs Daytona (previous plan)

| Item | Daytona self-hosted | GCP native |
|---|---|---|
| Sandbox compute | GKE node cost + Daytona ops | **$0.085/vCPU-hr (managed)** |
| Operational overhead | Daytona cluster maintenance | **None (GCP managed)** |
| CUD discounts | GKE only | **GKE + Agent Platform** |
| Free tier | None | **50 vCPU-hrs/mo free** |
| Billing complexity | GKE + Daytona metrics | **Single GCP bill** |

---

## 13. Phased Rollout (with test criteria)

Each milestone has a concrete **Test** that must pass before moving to the next step. This ensures nothing is built on a broken foundation.

---

### Phase 1: Git Workspace + Vault (2-3 weeks)

**Goal:** User's `~/Papr` files and credentials are in the cloud, accessible by any client.

#### Milestone 1A: GitHub App + Repo Creation (~3 days) ✅ DONE

**Built:**
- Created `papr-work` GitHub Org (free tier)
- Created GitHub App (`papr-workspace-bot`) with `contents:write` + `metadata:read`
- Installed app on `papr-work` org
- Memory server: `services/github_repos.py` — create repo, generate installation tokens
- Memory server: `POST /v1/cloud/repos/init` and `POST /v1/cloud/repos/token` endpoints
- Memory server: `POST /v1/cloud/vault/sync` and `GET /v1/cloud/vault/keys` endpoints

**Learnings:**
- GCP Secret Manager labels must be lowercase (org IDs can contain uppercase) — added `.lower()` in `vault_service.py`
- `cloud_routes.py` needed `get_memory_graph(request)` not `get_memory_graph()` (FastAPI dependency injection)
- Repo naming uses `org-{orgId}-ns-{nsId}-u-{userId}` (lowercase, dash-separated) — original `{org}--{ns}--{user}` scheme had issues with GitHub's repo name constraints

**Pass criteria:** ✅ Repo created, private, correctly named, ACL-isolated.

#### Milestone 1B: Repo Token + Desktop Git Sync (~4 days) ✅ DONE

**Built:**
- Memory server: `POST /v1/cloud/repos/token` — returns short-lived clone URL with `x-access-token`
- Paprwork Gateway: `CloudSyncService.ts` — git clone/pull/push with incremental queue
- Gateway: `/api/sync/status` and `/api/sync/push` endpoints
- Gateway: Cloud proxy handler for `/api/cloud/*` routes to memory server
- Conditional init: `CLOUD_SYNC_ENABLED` env var (defaults ON, user can disable in Settings → Privacy)

**Architecture — Incremental Queue-Based Sync:**

The original plan assumed `git add -A` would work. In practice, `~/Papr` can contain 133K+ files (job venvs, node_modules, chrome profiles, etc.), making bulk add impossible (ETIMEDOUT after 60s). The solution uses two phases:

```
Phase 1 — INSTANT_DIRS (small, file-watched):
  workspace/  → MEMORY.md, IDENTITY.md, BRAND.md (~10 files)
  data/       → apps.json, jobs.json, settings, plans (~20 files)
  .gitignore  → always synced
  
  Trigger: chokidar file watcher with 5s debounce
  Speed: <2s per sync

Phase 2 — QUEUED_DIRS (large, incrementally processed):
  apps/{appId}/   → each app dir queued as one item
  Jobs/{jobId}/   → each job dir queued as one item
  
  Trigger: enqueueSubDirs() on startup, processes one at a time
  Speed: ~5s per item (git add + diff check + commit + push)
  Initial sync: ~275 items ≈ 23 minutes
  Already-synced items: ~1.5s each (skip after diff check)
```

**Critical `.gitignore` patterns (learned the hard way):**
```
**/venv/
**/.venv/
**/node_modules/
**/__pycache__/
**/dist/
**/.versions/
**/*.db
**/*.db-wal
**/*.db-shm
**/logs/
**/*.log
.env
*.pem
*.key
**/chrome-profile/
**/.DS_Store
```

**Performance Learnings:**

| Issue | Cause | Fix |
|-------|-------|-----|
| `git add -A` timeout | 133K files in ~/Papr | Queue per-subdir instead |
| `git status --porcelain` ENOBUFS | Output exceeded 1MB buffer | Use `git diff --cached --name-only` + maxBuffer 10MB |
| chokidar EMFILE | Too many file watchers on apps/Jobs | Only watch `INSTANT_DIRS`, queue large dirs |
| `index.lock` stale files | Interrupted git operations | `cleanStaleLock()` removes locks older than 15s |
| Token expiry during long syncs | Initial sync takes 23+ min | Token refresh with `fetchRepoToken()` before each push |
| Express 5 wildcard routes | `app.all("/api/cloud/*", ...)` → PathError | Use regex: `/^\/api\/cloud\/(.*)/` |

**Pass criteria:** ✅ Bidirectional sync works. INSTANT_DIRS sync within 5s. QUEUED_DIRS process incrementally. GitHub changes appear locally on restart.

#### Milestone 1B-hardening: Production Readiness for Git Sync (~2-3 days) ✅ DONE

**Goal:** Make CloudSyncService reliable for production users without manual intervention.

**Build:**
1. **Persistent queue state** ✅ — `SyncStateManager` in `cloudSync/syncState.ts` tracks synced items with content hashes (mtime+size). On restart, only changed items re-queue.
2. **Delete detection** ✅ — `detectAndSyncDeletions()` identifies locally deleted files/dirs and `git rm -r` them from the remote repo.
3. **Periodic pull** ✅ — Timer every `PULL_INTERVAL_MS` calls `git pull` during session. Changes from other devices appear within minutes.
4. **Sync status UI** ✅ — `SyncStatusCard` component in Settings → Privacy → Cloud Sync shows real-time status for both workspace (git) and credentials (vault) with green/orange/red dots, queue progress, key counts, relative timestamps, and error details. Polls `/api/sync/status` and `/api/vault/status` every 5s.
5. **~~Opt-in default~~** ✅ — Enabled by default, user can disable in Settings → Privacy → Cloud Sync toggle. Setting persisted in `$PAPR_HOME/data/settings.json`, read by main process on startup.
6. **Memory server URL** ✅ — Uses `PAPR_MEMORY_SERVER_URL` env var (default: `https://memory.papr.ai`). Cloud proxy in gateway resolves at request time.
7. **Error recovery** ✅ — Failed queue items re-queued up to `MAX_RETRY_FAILURES` (3), then skipped with warning log.
8. **Conflict resolution** ✅ — Local-wins with stash/pop pattern in `pullChanges()`.

**Learnings:**
- Vault sync of 52 keys takes ~85s (GCP Secret Manager ~1.6s per write). Need 120s timeout for push, 15s for pull.
- Cloud proxy also needs timeout (120s for vault/sync, 30s default) to prevent gateway from hanging.
- `PAPR_MEMORY_SERVER_URL` must propagate via `...process.env` in Electron's gatewayEnv (verified working).

**Pass criteria:** ✅ Restarts are fast (no full re-queue), deletes propagate, periodic pull works, offline-safe, sync status visible in UI.

#### Milestone 1C: Credentials Vault (~3 days) — ✅ DONE

**Server side (DONE):**
- Memory server: `services/vault_service.py` — GCP Secret Manager CRUD ✅
- Memory server: `POST /v1/cloud/vault/sync` and `GET /v1/cloud/vault/keys` ✅
- GCP Secret Manager labels lowercased for compatibility ✅

**Client side (DONE):**
- `src/gateway/services/VaultSyncService.ts` — push/pull keychain ↔ vault ✅
- `CustomKeysService.onKeyChange()` listener — auto-push on key add/update/delete ✅
- Pull vault key names on startup for cross-device awareness ✅
- `/api/vault/status` and `/api/vault/push` gateway endpoints ✅
- Gated by `CLOUD_SYNC_ENABLED` (same toggle as git sync) ✅

**Learnings:**
- GCP Secret Manager label values must match regex `[a-z0-9_-]` — org IDs with uppercase chars were rejected until we added `.lower()`
- Vault naming: `vault--{org}--{ns}--{user}--{KEY_NAME}` works well for ACL isolation

**Test:**
```bash
# 1. Add a custom key in Paprwork Settings (e.g., "TEST_KEY" = "test-value-123")

# 2. Check vault has it
curl https://memory.papr.ai/v1/cloud/vault/keys \
  -H "X-API-Key: $PAPR_API_KEY"

# Expected: { "keys": [{ "name": "TEST_KEY", "syncedAt": "..." }] }

# 3. Verify ACL isolation — different API key should NOT see TEST_KEY

# 4. Delete the key in Paprwork Settings
# Call /v1/cloud/vault/keys again — TEST_KEY should be gone

# 5. Verify secret exists in GCP Secret Manager console
#    Name: vault--{org}--{ns}--{user}--TEST_KEY
```

**Pass criteria:** Keys sync from Keychain → Secret Manager. ACL-isolated. Deletions propagate.

---

### Phase 2: Cursor on Memory Server (1-2 weeks)

**Goal:** Cursor Composer works end-to-end via Papr login.

#### Milestone 2A: Cursor SDK on Cloud Run (~4 days)

**Build:**
- Memory server: `services/cursor_agent_service.py` — cursor-sdk wrapper
- Memory server: `POST /v1/ai/cursor/runs/stream` endpoint
- Clone user's repo to ephemeral disk, inject env vars, run cursor-sdk
- Stream SSE events back to client

**Test:**
```bash
# 1. Call the endpoint directly with curl (bypass Paprwork)
curl -N -X POST https://memory.papr.ai/v1/ai/cursor/runs/stream \
  -H "X-API-Key: $PAPR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chatId": "test-1", "prompt": "List the files in the workspace", "provider": "cursor", "model": "composer-2.5"}'

# Expected: SSE stream with session-meta → text-delta events → done

# 2. Verify repo was cloned (check logs for git clone timing)

# 3. Verify vault keys were injected (agent should be able to reference them)

# 4. Ask agent to create a file:
#    prompt: "Create a file called test.txt with 'hello world'"
# After done event, check GitHub repo — test.txt should be committed
```

**Pass criteria:** SSE stream works end-to-end. Agent can read/write repo files. Changes committed and pushed.

#### Milestone 2B: Paprwork UI Integration (~3 days)

**Build:**
- Connect existing `CursorDelegationService` to the live endpoint
- Ensure git push happens before cloud run starts
- Ensure git pull happens after cloud run completes

**Test:**
```
1. Open Paprwork, select Composer 2.5 from model picker
2. Send: "What files are in my workspace?"
   → Should see streamed response listing ~/Papr files
3. Send: "Create a new file called cloud-test.md with 'Created from cloud'"
   → Should see tool calls in Working card
   → After completion, $PAPR_HOME/workspace/cloud-test.md should exist locally
4. Check GitHub repo — cloud-test.md committed
5. Check cost tracking — session should appear in Stripe meter
```

**Pass criteria:** Full loop: Paprwork UI → memory server → cursor-sdk → git push → desktop git pull. Single message card, no duplicate streams.

---

### Phase 3: Turso + GKE Agent Sandbox (2-3 weeks)

**Goal:** Full cloud runtime with DB sync and isolated sandboxes.

#### Milestone 3A: Turso Database Provisioning (~3 days) ✅ DONE

**Built:**
- Turso org: `amirkabbara` (prod); naming `p-{org8}-{ns8}-{user8}-job-{jobId}`
- Memory server: `services/turso_service.py` — create/list/token
- Memory server: `POST /v1/cloud/databases/list` and `POST /v1/cloud/databases/token`
- ACL isolation verified (user A cannot access user B's database)

**Test:**
```bash
# 1. Create a database
curl -X POST https://memory.papr.ai/v1/cloud/databases/token \
  -H "X-API-Key: $PAPR_API_KEY" \
  -d '{"database": "job-test123"}'

# Expected: { "tursoUrl": "libsql://papr--orgA--nsB--user123--job-test123.turso.io", "authToken": "..." }

# 2. Connect and write data
python3 -c "
import libsql_experimental as libsql
conn = libsql.connect(':memory:', sync_url='<tursoUrl>', auth_token='<token>')
conn.execute('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
conn.execute('INSERT INTO test VALUES (1, \"hello\")')
conn.sync()
print('Write OK')
"

# 3. Read from a different connection (simulating sandbox)
# Same URL + token should return the data

# 4. ACL: different user's API key should NOT access this database
```

**Pass criteria:** Per-user databases created on demand. Read/write works via libSQL. ACL-isolated.

#### Milestone 3B: TursoSyncBridge — Job Boundary Sync (~3 days)

**Build:**
- `src/gateway/services/TursoSyncBridge.ts` — push/pull job `data.db` ↔ Turso (logic from `scripts/test-turso-job-sync.mjs`)
- Memory server: `POST /v1/cloud/databases/token` (✅ done) for short-lived Turso auth
- Hook push before cloud agent runs (`cursorAgentStream.ts` — already has `pushNow()`)
- Hook pull after cloud run completes (`pullNow()`)
- Hook push after local job completes (if job has Turso mapping)

**Do NOT build:**
- libsql background sync with better-sqlite3 (broken — see test `scripts/test-turso-sync-coexist.py`)
- Turso sync for chats or plans (PAPR Memory + git cover those)

**Test:**
```
1. Create job with data.db, insert row via better-sqlite3
2. TursoSyncBridge.push(jobId) → row visible in Turso dashboard
3. Simulate cloud: pull into fresh file → read row ✅
4. Cloud writes new row → push → desktop pull → both rows ✅
5. Local job completes → auto-push → Turso updated
```

**Pass criteria:** Job `data.db` round-trips via boundary push/pull. Local job code unchanged. No background sync worker.

#### Milestone 3B-hardening: Automatic Turso Freshness (~2–3 days) ✅ DONE

**Goal:** Turso stays within seconds of local SQLite without user or agent action. Closes the gap between “bridge exists” and “web always has data.”

**Built (paprwork-v2):**
- `tursoPushScheduler.ts` — debounced push per job (default 8s, `TURSO_PUSH_DEBOUNCE_MS`)
- `tursoSyncState.ts` — `$PAPR_HOME/data/.turso-sync-state.json` tracks last push mtime per job
- `TursoLinkedDbWatcher.ts` — chokidar on linked `data.db` (+ WAL/SHM) files
- Hooks:
  - After `/api/db/write` and `/api/db/exec` → `scheduleTursoPushForJob`
  - After job completion → debounced push (via scheduler)
  - After `linkAppDataSource` / auto-discover → push + refresh watcher
  - After CloudSync `finalizeBatchSync` (git push) → `scheduleTursoPushAllLinked`
  - On gateway startup (after pull) → push dirty linked jobs + start watcher
- `tests/turso-push-scheduler.test.ts` — unit tests for sync state + scheduler

**Pass criteria:** ✅ Web `apps.papr.ai` sees data without manual Turso push. Local writes trigger debounced push within ~10s.

**Follow-up (not in this milestone):**
- `appRuntime/DbRouter` — local SQLite with Turso fallback when `data.db` missing
- Auto cloud-publish when sync healthy (see 3E + 3F)

#### Milestone 3E: Cloud Mini-App Host (~1–2 weeks) 🟡 PARTIAL

**Goal:** Shareable mini-app URLs with backend-proxied Turso read/write. No Turso secrets in the browser.

**Built (paprwork-v2):**
- `src/gateway/services/appRuntime/` — shared SQL validation, data-source resolution, Turso table rewrite
- `src/gateway/cloud-app-host.ts` — standalone Express entry (`CLOUD_APP_HOST=true`)
- `CloudAppHostService`, `CloudAppHostAuthService`, `TursoDbAdapter` — git file serving + `/api/db/*`
- Gateway publish handlers: `GET/POST/DELETE/PATCH /api/cloud/publish/:appId`
- Share sheet UI: `MiniAppPublishBar` + `useCloudPublish` (audience model, copy link, unpublish)
- `CloudAppPublishService` — publish to memory server with catalog metadata (title, description, icon)
- Reuse existing mini-app transpile/static asset logic from `src/gateway/index.ts`
- E2E: `scripts/test-cloud-app-host-e2e.mjs`, `scripts/test-cloud-publish-permissions-e2e.mjs`

**Built (memory server):**
- `POST /v1/cloud/apps/publish` — register slug, visibility, `codeAccess`, share token (hashed at rest)
- `GET /v1/cloud/apps/publish/{appId}` — owner reads publish config
- `DELETE /v1/cloud/apps/publish/{appId}` — disable cloud link
- `POST /v1/cloud/apps/access/validate` — server-side; Cloud App Host validates Papr session or share token

**Remaining:**
- Production deploy of `cloud-app-host.ts` to Cloud Run as `apps.papr.ai`
- DNS + TLS for `apps.papr.ai` (see `scripts/setup-apps-papr-ai-dns.mjs`)
- Cloud App Host hardening (rate limits, cold start, error pages)
- Settings → Apps bulk "Enable cloud link" (Share sheet covers per-app today)
- `appRuntime/DbRouter` fallback when local `data.db` missing

**Prerequisites:** Milestone 1B (git sync), 3B (Turso push for linked sources), correct Papr org repo.

**Test:**
```
1. Enable cloud link for app → memory returns slug + share URL
2. Open apps.papr.ai/{slug} in incognito (no Papr login)
3. App loads index.html from git
4. fetch('/api/db/query') returns rows (Turso via backend)
5. link_read_write token → /api/db/write succeeds; link_read → write returns 403
6. Turso token never appears in browser DevTools network tab
7. Desktop gateway unchanged — same app works locally at localhost:18789
```

**Pass criteria:** Shared URL works without Electron. DB reads/writes via backend only. Share token ACL enforced.

#### Milestone 3F: Community Catalog + Fork/Track Install (~1 week) ✅ DONE (2026-06-30)

**Goal:** Discover public cloud apps in Paprwork, install source as fork or track, contribute changes back to owner. Prefer cloud publish over GitHub export when Cloud Sync is enabled.

**Built (memory server):**
- `codeAccess` field on publish (`off` | `install`) — gates Community listing + install API
- `GET /v1/cloud/apps/community` — public catalog with rich metadata (name, description, icon, author, tags)
- `POST /v1/cloud/apps/install` — git clone publisher app subtree; returns clone token + lineage id
- Change request CRUD: submit, list incoming, approve/reject (v1 records metadata; no auto git merge yet)
- Catalog metadata on publish: `catalogTitle`, `catalogDescription`, `catalogIcon`

**Built (paprwork-v2 gateway):**
- `CommunityCatalogService` — merges open-source bundles + cloud community entries
- `CloudAppInstallService` — local install via `/api/cloud/install`; writes `papr-cloud-lineage.json`
- `CloudAppLineageService` — indexes lineage by app id and source key (`namespaceId:slug`)
- `GET /api/cloud/lineage` — lineage index for UI
- `cloudPublishGate.ts` — agent tool gating (Cloud Sync + Papr login); structured fallback to `export_app_bundle`
- Agent tools: `publish_cloud_app` (+ `codeAccess`), `install_cloud_app`, `submit/list/resolve_cloud_app_change`
- System prompt + `APP_AND_JOBS_GUIDE.md` — cloud-first sharing decision tree

**Built (paprwork-v2 UI):**
- `CommunityAppsView` — rich cards (icon, description, "Yours", fork count), real cloud install
- Install mode picker modal: **Fork** (independent copy) vs **Track upstream** (lineage only; sync TBD)
- `AppCard` — Fork/Track badges from `cloudLineage`
- `MiniAppPublishBar` — Share sheet unpublish ("Remove from Community", "Unpublish from Papr Cloud")
- `CloudChangeRequestsPanel` — owner approve/reject incoming requests
- `CloudContributeBackPanel` — fork users submit change requests upstream
- `websocket/app.ts` — enriches `app:list` / `app:get` with `cloudLineage`

**Tests:**
- `npm run test:cloud-community-install` — publish → community → fork install → unpublish
- `tests/cloud-publish-gate.test.ts` — Cloud Sync / login gating
- `tests/share-audience-model.test.ts` — audience ↔ codeAccess mapping

**Pass criteria:** ✅ Public app appears in Community tab. Install creates local app + lineage file. Fork badge visible. Owner sees change requests. Agent prefers `publish_cloud_app` with `codeAccess=install`; falls back to export when cloud unavailable.

**Remaining (3F follow-ups):**
- **Track mode upstream sync** — lineage stored; UI says "automatic sync coming soon"; need pull-on-publish + conflict UI
- **Git merge on approve** — change request approve currently metadata-only; need diff/merge into publisher repo
- Extend `memory/scripts/cloud/test_cloud_e2e.py` with community/install/change-request paths

#### Milestone 3C: GKE Agent Sandbox (~5 days)

**Build:**
- GKE Autopilot cluster in `us-central1` with Agent Sandbox enabled
- Papr base image pushed to Artifact Registry
- Memory server: `services/gke_sandbox_service.py` — create/destroy sandboxes, inject env vars
- Memory server: `POST /v1/cloud/runtime/sessions/stream` with `tier: "sandbox"`

**Test:**
```bash
# 1. Provision a sandbox
curl -N -X POST https://memory.papr.ai/v1/cloud/runtime/sessions/stream \
  -H "X-API-Key: $PAPR_API_KEY" \
  -d '{"chatId": "test-sandbox", "prompt": "Run python3 -c \"print(42)\"", "provider": "cursor", "model": "composer-2.5", "tier": "sandbox"}'

# Expected: SSE stream, agent runs code in sandbox, result includes "42"

# 2. Test vault injection — ask agent to echo $TEST_KEY
#    Should see the value from Secret Manager

# 3. Test Turso in sandbox — ask agent to query data.db
#    TursoSyncBridge pull before run, push after
#    Desktop should see new data after pullNow()

# 4. Test git writeback — ask agent to create a file
#    File should appear in GitHub repo AND on desktop after git pull

# 5. Measure startup time — sandbox creation should be <2 seconds

# 6. Verify cleanup — sandbox should be destroyed after session ends
#    kubectl get pods | grep papr-sandbox → should be gone
```

**Pass criteria:** Full sandbox lifecycle works. Vault keys injected. Turso data syncs. Git writeback. Sub-2s startup. Clean destruction.

#### Milestone 3D: Paprwork Cloud Runtime UI (~3 days)

**Build:**
- Generalize `CursorDelegationService` → `CloudRuntimeService`
- UI indicator: "Running in cloud" vs "Running locally"
- Route all cloud providers through `CloudRuntimeService`

**Test:**
```
1. Select Composer 2.5 → UI shows "Running in cloud ☁️"
2. Select Claude (API key) → UI shows normal local execution
3. Cloud run: agent creates file → appears in ~/Papr after completion
4. Cloud run: agent writes to data.db → TursoSyncBridge pull → data in local SQLite
5. Error handling: kill sandbox mid-run → user sees clean error, can retry
```

**Pass criteria:** Cloud and local execution both work from same UI. Cloud indicator visible. Error recovery works.

---

### Phase 4: Cloud Scheduler + MCP Bridge

**Goal:** Scheduled jobs run in cloud while Mac is asleep; optional hybrid tools via MCP.

#### Milestone 4A: Shared Cloud Scheduler Worker (~5 days)

**NOT** a per-user gateway. One multi-tenant worker (Cloud Run or GKE deployment) that:

- Reads each user's `jobs.json` from their git repo (GitHub App)
- Runs scheduler tick (same logic as local `JobsScheduler`, but cloud-side)
- On job due: if desktop heartbeat stale → provision GKE sandbox → Turso pull → run → Turso push → git commit → destroy
- If desktop heartbeat fresh → skip (local gateway handles it)
- Exposes WebSocket status to desktop ("Job ran in cloud while you were away")

**Build:**
- `memory/services/cloud_scheduler_service.py` — multi-tenant tick loop
- `memory/services/gke_sandbox_service.py` — create/destroy sandboxes, inject env
- Desktop heartbeat: gateway pings memory server every 60s when awake

**Test:**
```
1. Create scheduled job locally (every 5 min)
2. Close laptop / stop gateway heartbeat
3. Cloud worker detects due job → sandbox runs → Turso + git updated
4. Wake Mac → git pull + TursoSyncBridge pull → see job output
5. Mac awake again → cloud worker defers to local gateway
```

**Pass criteria:** Jobs run in cloud when Mac asleep. Local gateway preferred when awake. No per-user VMs.

#### Milestone 4B: MCP Bridge (optional)

- Paprwork Gateway exposes MCP server on secure tunnel
- Sandbox configures MCP client → hybrid mode (cloud compute + local tools)
- **Test:** Cloud agent calls local bash tool via MCP bridge → result streamed back

---

## 13b. Implementation Tiers (reco alignment)

Short-term delivery order aligned with reliability/security/performance review:

| Tier | Scope | Plan milestones |
|------|--------|-----------------|
| **Tier 1** | Auto Turso freshness, zero user action | **3B-hardening** ✅ |
| **Tier 2** | Community catalog, fork/install, share sheet, agent cloud-first publish | **3F** ✅ + **3E** deploy 🟡 |
| **Tier 3** | Cloud runtime UI, DbRouter fallback | 3D + 3E hardening |
| **Tier 4** | Jobs while Mac asleep, Papr Web | 3C sandbox + 4A scheduler + 5 |

Tier 1–2 complete the data + sharing glue inside Phase 1 + 3B + 3E/3F. Tier 3–4 are the long-term cloud compute story.

---

### Phase 5: Web Paprwork (future)

**Goal:** Browser-only Paprwork client with the same mini-app experience as the Mac app.

**Architecture (uses Phase 3E — do not build a second runtime):**

```
Papr Web (papr-dev-platform)
  ├── Chat UI → memory server AI proxy + /v1/cloud/runtime/*
  ├── Mini-apps → iframe src="https://apps.papr.ai/{slug}" OR dashboard reverse-proxy
  └── Settings / billing / Auth0 (existing)
```

- GitHub repo remains source of truth for app code (no local `~/Papr` in browser).
- **Database access:** Papr Web embeds or proxies the **Cloud App Host** — mini-apps still call `/api/db/*` same-origin relative to the iframe origin (`apps.papr.ai`), **not** Turso directly in the browser.
- Agent execution via cloud runtime (Phase 3C+).
- Same ACL model, same billing, same share links as desktop.

**Amendment (v7):** Phase 5 previously said "Turso HTTP API for all database reads/writes" — **rejected**. Client-side Turso would expose credentials and duplicate logic. Backend proxy only.

**Test:** Open dashboard.papr.ai → open shared mini-app → read/write data → run cloud job. Zero local install.

---

## 14. Implementation Learnings (from Phase 1)

Captured during Milestones 1A and 1B implementation — these inform future phases.

### Turso / SQLite Coexistence (2026-06-18)

Test scripts: `scripts/test-turso-sync-coexist.py`, `scripts/test-turso-better-sqlite-coexist.mjs`, `scripts/test-turso-job-sync.mjs`

1. **Background libsql sync FAILS with better-sqlite3** — writes made via `better-sqlite3` or Python `sqlite3` are not uploaded by libsql `sync()` while another process holds the file.
2. **Boundary table-copy bridge WORKS** — read all tables from local SQLite → upsert Turso staging replica → `sync()`. Verified round-trip desktop → cloud → desktop.
3. **Keep better-sqlite3 locally** — no migration to `@libsql/client` for job DBs. Bridge runs at job/cloud-run boundaries only.
4. **Chats skip Turso** — PAPR Memory / Parse / MongoDB is the chat sync channel.

### Git Sync Architecture

The original design assumed a simple `git add -A && git commit && git push` loop. Reality:

1. **~/Papr is massive** — 133K+ files including Python venvs (50-500MB each), node_modules, chrome profiles. `git add -A` times out after 60s.
2. **Two-phase approach works** — Small dirs (`workspace/`, `data/`) sync instantly via chokidar. Large dirs (`apps/`, `Jobs/`) queue per-subdirectory for incremental processing.
3. **`.gitignore` is critical** — Without proper patterns, `git add` tries to stage 100K+ ephemeral files. Need `**/.venv/`, `**/node_modules/`, `**/*.db`, `**/chrome-profile/`, etc.
4. **Buffer overflows** — `git status --porcelain` on a large repo can exceed Node.js 1MB default buffer. Use `maxBuffer: 10MB` and prefer `git diff --cached --name-only` for checking staged changes.
5. **Stale lock files** — Interrupted git operations leave `.git/index.lock`. Need cleanup logic before each operation.
6. **Initial sync is slow** — ~275 app/job subdirs × 5s each = 23 minutes. Subsequent syncs are fast (~1.5s per unchanged item).

### API & Infrastructure

1. **Express 5 wildcard routes** — `app.all("/api/cloud/*")` fails with PathError. Use regex: `/^\/api\/cloud\/(.*)/`.
2. **GCP label constraints** — Secret Manager labels must be lowercase regex `[a-z0-9_-]`. Org IDs with uppercase chars are rejected. Apply `.lower()`.
3. **MongoDB environment** — Dev (`parsedev`) vs prod (`parseprodtemp`) databases have different user records. E2E tests with real API keys need prod-equivalent data.
4. **FastAPI dependency injection** — `get_memory_graph()` must receive `request` arg, not be called standalone.
5. **GitHub App installation tokens** — Expire after 1 hour. Long-running initial syncs need token refresh before each push.

### Implications for Future Phases

- **Phase 2 (Cursor on Cloud Run):** Cloud Run instances should `git clone --depth=1` the user's repo. With `.gitignore` excluding venvs/node_modules, clone sizes should be manageable (most repos <100MB of source).
- **Phase 3 (Turso):** SQLite files are gitignored (`**/*.db`). Turso boundary sync via TursoSyncBridge — NOT background libsql sync with better-sqlite3 (tested broken). Job code unchanged.
- **Phase 4 (Cloud scheduler):** Shared multi-tenant worker, not per-user gateway. Sandboxes rebuild venv/node_modules from repo; Dockerfile installs deps at build time.
- **Web Paprwork (Phase 5):** GitHub repo is source of truth — no local `~/Papr`. Web client reads/writes via git (or GitHub API). The queue-based architecture doesn't apply (no local filesystem).

---

## 15. Security Considerations

| Concern | Mitigation |
|---|---|
| Cross-tenant repo access | GitHub App tokens scoped to single repo per user |
| Cross-tenant DB access | Turso tokens scoped to single database per request |
| Cross-tenant vault access | Secret names include org/ns/user prefix; ACL check before resolve |
| Provider API keys | Server-side only (CURSOR_API_KEY, etc.); injected as env vars, never in repos or client |
| User custom keys | Vault sync over HTTPS; GCP Secret Manager AES-256 at rest; sandbox-scoped lifetime |
| Sandbox isolation | GKE Agent Sandbox uses gVisor kernel isolation; configurable network policies |
| Git credentials | GitHub App installation tokens (1-hour expiry, single-repo scope) |
| Turso credentials | Short-lived auth tokens (configurable expiry) |
| SQLite data in git | `.gitignore` prevents accidental commit; server-side validation |
| Repo visibility | All repos private; only accessible via Papr-issued tokens |

---

## 16. Open Questions (Resolved + Remaining)

### Resolved (from v1 → v3 reviews)

| Question | Decision |
|---|---|
| GCS vs GitHub for workspace sync? | **GitHub** — agent CLIs speak git natively, conflict resolution for free |
| E2B vs Daytona vs GCP? | **GCP (GKE Agent Sandbox + Cloud Run)** — already on GCP, sub-second starts, gVisor isolation, unified billing, CUD discounts, no third-party vendor |
| SQLite sync strategy? | **Turso + TursoSyncBridge** — job `data.db` only; boundary table-copy push/pull; keep better-sqlite3 locally |
| Custom keys in sandbox? | **Cloud vault** (GCP Secret Manager) — synced from Keychain, injected per run |
| Do users need a GitHub account? | **No** — Papr owns the GitHub Org, repos are infrastructure, users only need PAPR_API_KEY |
| Onboarding GitHub step? | **None** — repo created automatically server-side on sign-up, user never sees GitHub |
| GCP for sandbox/compute? | **Yes** — unified Compute Unit at $0.085/vCPU-hr, 50 free vCPU-hrs/mo, CUDs apply, same platform as memory server |

### Resolved (from v6 review — 2026-06-18)

| Question | Decision | Rationale |
|---|---|---|
| Per-user 24/7 cloud gateway? | **No** — shared multi-tenant scheduler worker | $35–50/user/month at scale; worker + sandbox is ~$200–500/mo total |
| Turso for chats/plans? | **No (v1)** — job `data.db` only | PAPR Memory already syncs chat; plans in git `data/` |
| Replace better-sqlite3 with libsql? | **No** — TursoSyncBridge at boundaries | Tested: external writes don't replicate via libsql `sync()` |
| Cloud job execution model? | **Shared worker schedules → GKE sandbox per run** | Security (gVisor) + cost (~$0.01/run) |
| Mac awake vs asleep? | **Local gateway when awake; cloud when heartbeat stale** | Zero cloud cost during active use |

### Resolved (from v3 review)

| Question | Decision | Rationale |
|---|---|---|
| Turso vs Neon? | **Turso** | Every job already uses `sqlite3` / `better-sqlite3`. Turso is drop-in (same SQL). Neon requires query rewrites. Per-DB model maps naturally to per-job isolation. |
| GitHub org plan? | **Free tier** (upgrade later) | Free orgs get unlimited private repos. Only 1 bot seat needed. Upgrade to Team ($4/seat/mo) only when GitHub Actions needed (Phase 4+). |
| Conflict resolution? | **Serialized: desktop pushes before cloud run** | Simplest, safest. Runtime API step 2 already requires "ensure workspace is pushed". No merge conflicts possible. Add branching later if web+desktop edit concurrently. |
| Turso pricing at scale? | **Per-job DB model, free tier first** | 500 DBs free. Typical user ≈ 20 job DBs (no chats/plans in Turso v1). Scaler at $2.95/mo when needed. |
| GKE cluster sizing? | **Autopilot in `us-central1`** | Auto-scales, co-located with Cloud Run. Start x86, evaluate Axion N4A (ARM, ~30% cheaper) once base image is stable. |
| GitHub App scope? | **Private, `contents:write` + `metadata:read`** | Minimum permissions. No marketplace listing. Installed only on `papr-work` org. |
| CUD commitment? | **Not yet — wait for 2-3 months of Phase 3 data** | CUDs need predictable baseline. Evaluate 1-year commitment once sandbox usage stabilizes. |

### Resolved (from Phase 1 implementation)

| Question | Decision | Rationale |
|---|---|---|
| Bulk or incremental git add? | **Incremental queue** per subdirectory | `git add -A` on 133K files times out. Queue processes one app/job at a time (~5s each). |
| File watcher scope? | **Only INSTANT_DIRS** (workspace, data) | chokidar on all of ~/Papr causes EMFILE (too many open files). Large dirs use queue, not watchers. |
| Git buffer handling? | **maxBuffer: 10MB + git diff --cached** | `git status --porcelain` overflows default 1MB buffer. `git diff --cached --name-only` is smaller and only shows staged files. |
| GitHub org naming? | **`papr-work`** (not `papr-workspaces`) | Shorter, cleaner. Repo naming: `org-{id}-ns-{id}-u-{id}` (lowercase, dash-separated). |
| Sync default for release? | **ON by default, opt-out in Settings** | Enabled by default. Users can disable in Settings → Privacy → Cloud Sync toggle. Takes effect on restart. |
| .gitignore strategy? | **Always overwrite from code** | Ensures latest patterns applied. Critical patterns: `**/.venv/`, `**/*.db`, `**/chrome-profile/`, `**/.DS_Store`. |

### Remaining

| Question | Context |
|---|---|
| Conflict resolution strategy? | What happens when `git pull` has conflicts with local changes? Current: not handled. Options: local-wins (stash/pop), last-writer-wins, manual resolution UI. |
| Queue persistence format? | JSON file vs SQLite for tracking synced items. JSON is simpler but SQLite scales better. |
| Delete detection mechanism? | `git add -u` stages deletions for tracked files. But if user deletes an app, we need to detect that the directory is gone and `git rm -r` it. Periodic full-repo scan? Or hook into AppService/JobsService delete events? |
| Sync frequency for large dirs? | Initial queue runs once on startup. Should we re-scan for changes periodically (every 30min)? Or only on explicit user action / app events? |

---

## 17. Files to Create/Modify

### Memory server (new) — Status

| File | Purpose | Status |
|---|---|---|
| `routers/v1/cloud_routes.py` | `/v1/cloud/*` — repos, databases, vault, runtime endpoints | ✅ Created |
| `services/github_repos.py` | GitHub App client, repo management, multi-scope token generation | ✅ Created |
| `services/vault_service.py` | GCP Secret Manager CRUD, ACL-scoped secrets (user/ns/org) | ✅ Created |
| `services/turso_service.py` | Turso API client, database provisioning, multi-scope tokens | ✅ Done (3A) |
| `services/cloud_app_publish_service.py` | App publish metadata + share token validation (MongoDB) | ✅ Done (3E) |
| `services/cloud_app_install_service.py` | Community install — git clone app subtree | ✅ Done (3F) |
| `services/cloud_app_changes_service.py` | Change request workflow (metadata v1) | ✅ Done (3F) |
| `services/gke_sandbox_service.py` | GKE Agent Sandbox provisioning, env injection, lifecycle management | ⏳ Phase 3C |
| `services/cloud_scheduler_service.py` | Multi-tenant job scheduler, desktop heartbeat, sandbox orchestration | ⏳ Phase 4A |
| `services/cursor_agent_service.py` | cursor-sdk wrapper (Phase 2) | ✅ Done (2A, local) |
| `models/cloud_models.py` | Pydantic models for all `/v1/cloud/*` APIs | ✅ Created |
| `models/operation_types.py` | Add new operation types | ⏳ |
| `tests/test_cloud_routes.py` | Cloud route tests (repos, vault, databases, runtime) | ⏳ |

### Memory server (modify)

| File | Change | Status |
|---|---|---|
| `routers/v1/__init__.py` | Register cloud router | ✅ Done |
| `routers/v1/ai_proxy_routes.py` | Add Cursor route (Phase 2) | ⏳ Phase 2 |
| `pyproject.toml` | Add `cursor-sdk`, `PyGithub`, `google-cloud-secret-manager`, `google-cloud-container`, `tursodatabase` | ✅ Partial (PyGithub, google-cloud-secret-manager) |
| `.env` | Add `CURSOR_API_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `TURSO_ORG_TOKEN`, `GKE_CLUSTER`, `GKE_PROJECT` | ✅ Partial (GitHub + GCP done) |
| `services/utils.py` | Fixed `get_memory_graph(request)` signature | ✅ Done |

### Paprwork (new)

| File | Purpose | Status |
|---|---|---|
| `src/gateway/services/appRuntime/` | Shared mini-app runtime (SQL validation, Turso adapter, access context) | 🟡 Partial (cloud path) |
| `src/gateway/cloud-app-host.ts` | Standalone Cloud Run entry for `apps.papr.ai` | 🟡 Built, deploy TBD |
| `src/gateway/services/CloudSyncService.ts` | Git sync (clone/pull/push) via user's cloud repo — incremental queue architecture | ✅ Created |
| `src/gateway/services/CommunityCatalogService.ts` | Unified Community catalog (OSS bundles + cloud apps) | ✅ Done (3F) |
| `src/gateway/services/CloudAppInstallService.ts` | Fork/track install from community | ✅ Done (3F) |
| `src/gateway/services/CloudAppLineageService.ts` | Index `papr-cloud-lineage.json` per installed app | ✅ Done (3F) |
| `src/gateway/services/CloudAppPublishService.ts` | Publish to memory server with catalog metadata | ✅ Done (3E/3F) |
| `src/gateway/utils/cloudPublishGate.ts` | Agent tool gating + export fallback | ✅ Done (3F) |
| `src/core/tools/cloudPublish.ts` | Agent `publish_cloud_app` with `codeAccess` | ✅ Done (3F) |
| `src/core/tools/cloudInstall.ts` | Agent install + change request tools | ✅ Done (3F) |
| `ui/components/Apps/CommunityAppsView.tsx` | Community tab — rich cards, install mode picker | ✅ Done (3F) |
| `ui/components/Apps/CloudChangeRequestsPanel.tsx` | Owner change-request UI | ✅ Done (3F) |
| `ui/components/Apps/CloudContributeBackPanel.tsx` | Fork contribute-back UI | ✅ Done (3F) |
| `scripts/test-cloud-sync-e2e.mjs` | E2E test script for CloudSyncService | ✅ Created |
| `scripts/test-cloud-community-install-e2e.mjs` | E2E publish → community → install | ✅ Done (3F) |
| `src/gateway/services/VaultSyncService.ts` | Push keychain to cloud vault | ✅ Done (1C) |
| `src/gateway/services/CloudRuntimeService.ts` | Generalized runtime streaming for all cloud providers | ⏳ Phase 3D |
| `src/gateway/services/TursoSyncBridge.ts` | Job `data.db` ↔ Turso boundary push/pull | ✅ Created (3B) |
| `src/gateway/services/tursoSyncBridgeCore.ts` | Table-copy push/pull core logic | ✅ Created (3B) |
| `src/gateway/services/tursoPushScheduler.ts` | Debounced auto-push hooks | ✅ Done (3B-h) |
| `src/gateway/services/tursoSyncState.ts` | Last-push mtime state (`$PAPR_HOME/data/.turso-sync-state.json`) | ✅ Done (3B-h) |
| `src/gateway/services/TursoLinkedDbWatcher.ts` | Watch linked `data.db` for job writes | ✅ Done (3B-h) |
| `tests/turso-push-scheduler.test.ts` | Unit tests for sync state + scheduler | ✅ Done (3B-h) |
| `scripts/test-turso-job-sync.mjs` | E2E test for boundary sync (passing) | ✅ Created |
| `scripts/test-turso-sync-bridge-e2e.mjs` | TypeScript TursoSyncBridge E2E (passing) | ✅ Created |

### Paprwork (modify)

| File | Change | Status |
|---|---|---|
| `src/gateway/index.ts` | Added cloud proxy, sync endpoints, CloudSyncService init/shutdown | ✅ Done |
| `src/gateway/services/providers/CursorDelegationService.ts` | Refactor into CloudRuntimeService | ⏳ Phase 2 |
| `src/gateway/types/cursorDelegation.ts` | Rename → `cloudRuntime.ts`, make provider-agnostic | ⏳ Phase 2 |
| `src/gateway/utils/cursorDelegationClient.ts` | Rename → `cloudRuntimeClient.ts` | ⏳ Phase 2 |
| `src/gateway/services/AgentService.ts` | Route cloud providers through CloudRuntimeService | ⏳ Phase 2 |
| `src/gateway/services/providers/cursorAgentStream.ts` | Wire TursoSyncBridge push/pull around cloud runs | ✅ Done |
| `src/gateway/services/CustomKeysService.ts` | Trigger vault sync on key changes | ⏳ TODO (1C client) |

---

## 18. Success Criteria (Summary)

Each milestone has detailed test criteria in §13 above. The gate-check summary:

| Milestone | Gate Test | Status | Blocks |
|---|---|---|---|
| **1A** GitHub App + repo | `POST /v1/cloud/repos/init` → private repo appears on GitHub, ACL-isolated | ✅ Done | 1B |
| **1B** Desktop git sync | Edit file in Paprwork → commit on GitHub within 5s (instant) or queued (apps/Jobs). Edit on GitHub → file in ~/Papr on restart | ✅ Done | 1B-h, 1C |
| **1B-h** Sync hardening | Persistent queue, delete detection, periodic pull, sync UI, opt-out toggle | ✅ Done | 2A |
| **1C** Credentials vault | Add key in Settings → appears in `GET /v1/cloud/vault/keys`. ACL-isolated | ✅ Done | 2A |
| **2A** Cursor on Cloud Run | `POST /v1/ai/cursor/runs/stream` → SSE stream with tool calls. Agent creates file → committed to repo | ✅ Done (local) | 2B |
| **2B** Paprwork UI | Select Composer 2.5 → cloud response streams in UI. File changes appear locally after completion | ⏳ Partial | 3B |
| **3A** Turso provisioning | Create DB via API → read/write via libSQL. ACL-isolated | ✅ Done | 3B |
| **3B** TursoSyncBridge | Job data.db round-trips via boundary push/pull. Job code unchanged | ✅ Done | 3E |
| **3B-h** Turso auto-push | Local writes → Turso within ~10s without manual action | ✅ Done | 3E |
| **3E** Cloud Mini-App Host | Shared URL; `/api/db/*` backend proxy; share token ACL; no Turso in browser | 🟡 Partial (code done; deploy TBD) | 3F, 3C, 4A, 5 |
| **3F** Community + install | Community catalog, fork/track install, change requests, agent cloud-first publish | ✅ Done | 3F follow-ups |
| **3C** GKE sandbox | Full sandbox lifecycle: vault injection, Turso bridge, git writeback, <2s startup, clean destroy | 🟡 Code done; GKE cluster + deploy TBD | 3D |
| **3D** Cloud runtime UI | Cloud indicator shows. Agent runs in sandbox. File + DB changes sync to desktop | 🟡 Gateway scaffold + plan | 4A |
| **4A** Cloud scheduler worker | Shared worker runs jobs when Mac asleep; defers when desktop heartbeat fresh | 🟡 Code done; deploy + `CLOUD_SCHEDULER_ENABLED=1` | 4B, 5 |
| **5** Web Paprwork | Browser chat + mini-apps via Cloud App Host embed; zero local install | ⏳ TODO | — |

---

## 19. What's Left (as of 2026-06-30)

### Near-term — Mini-app backend (3E-b) + Cloud App Host

| Priority | Item | Milestone | Notes |
|---|---|---|---|
| **P0** | Mini-app three-layer runtime | 3E-b | See `docs/MINI_APP_BACKEND_ARCHITECTURE.md` — block bash, allow jobs on share links, edge backend on Cloud App Host |
| **P0** | Deploy `cloud-app-host.ts` to `apps.papr.ai` | 3E | Code exists; needs Cloud Run + DNS (`scripts/deploy-cloud-app-host.mjs`) |
| **P0** | Memory server E2E for community/install | 3F | Extend `memory/scripts/cloud/test_cloud_e2e.py` (desktop script exists: `npm run test:cloud-community-install`) |
| **P1** | Track mode upstream sync | 3F | Lineage + UI done; implement pull-on-publish + optional auto-update for `mode=track` |
| **P1** | Git merge on change-request approve | 3F | Approve/reject UI works; v1 is metadata-only — need diff/PR into publisher repo |
| **P2** | `appRuntime/DbRouter` | 3E | Local SQLite with Turso fallback when `data.db` missing |
| **P2** | Settings bulk cloud-link toggle | 3E | Per-app Share sheet works; optional Settings → Apps overview |

### Cloud Agent Gateway (2026-06-30)

See **`docs/CLOUD_AGENT_GATEWAY_PLAN.md`** for full lifecycle (git + Turso + Mastra/pi-ai parity).

### Infra / deploy — finish verification (2026-06-30)

| Item | Status | How to finish |
|---|---|---|
| **GKE sandbox pods** | Code: `gke` + `auto` backends with **process fallback** when cluster unavailable (no hard 503). | Run `memory/scripts/setup-gke-sandbox.sh PROJECT_ID`. Set `CLOUD_SANDBOX_BACKEND=gke`, `GKE_*` on memory Cloud Run. Grant Cloud Run SA `roles/container.developer`. |
| **Git + Turso writeback E2E** | Implemented in `cloud_job_runner_service` + `papr_db_sync`; not live-verified. | Deploy memory, then `npm run test:cloud-writeback` (uses GitHub API + `POST /v1/cloud/runtime/job-run`). |
| **Scheduled agent jobs in cloud** | Scheduler runs agent jobs when `resolve_scheduler_api_key()` succeeds. | Set `CLOUD_SCHEDULER_SERVICE_API_KEY` (org override) **or** ensure Mongo `_User.userAPIkey` for each user. Enable `CLOUD_SCHEDULER_ENABLED=1`. |

**Verify commands**

```bash
# After memory deploy
npm run test:cloud-runtime
npm run test:cloud-writeback

# GKE (once cluster exists)
./memory/scripts/setup-gke-sandbox.sh YOUR_GCP_PROJECT
```

### Medium-term — cloud compute (original plan)

| Priority | Item | Milestone | Notes |
|---|---|---|---|
| **P1** | Composer 2.5 UI integration | 2B | Wire `CursorDelegationService` end-to-end in Paprwork UI |
| **P2** | GKE Agent Sandbox | 3C | Ephemeral job/agent execution with vault + Turso + git writeback |
| **P2** | Cloud runtime UI indicator | 3D | "Running in cloud ☁️" vs local; generalize to all cloud providers |
| **P3** | Shared cloud scheduler | 4A | Jobs run when Mac asleep; desktop heartbeat defers to local gateway |
| **P3** | MCP bridge (optional) | 4B | Hybrid cloud compute + local tools |

### Long-term

| Item | Milestone | Notes |
|---|---|---|
| Web Paprwork (browser client) | 5 | Chat via memory server; mini-apps embed `apps.papr.ai` |
| Billing meters for compute/workspace | §12 | Stripe meters for Turso, vault, compute units |

### Resolved this sprint (2026-06-30)

| Question | Decision |
|---|---|
| Community sharing: cloud vs GitHub export? | **Cloud-first** when Cloud Sync + Papr login enabled. Agent gets structured error + `export_app_bundle` fallback via `cloudPublishGate`. |
| How to indicate fork vs original? | **`papr-cloud-lineage.json`** + Fork/Track badges on `AppCard` and Community cards (`installedForkCount`, `isOwned`). |
| Third sharing axis? | **`codeAccess`** (`off` \| `install`) separate from live-app ACL (`loginAccess` + `externalLink`). |
| Duplicate community entries? | Two local forks of same source = two apps (expected). UI now distinguishes via lineage badges. |
| Unpublish from Community? | Share sheet: "Remove from Community" (listing only) or "Unpublish from Papr Cloud" (full unpublish). `DELETE /api/cloud/publish/:appId`. |
