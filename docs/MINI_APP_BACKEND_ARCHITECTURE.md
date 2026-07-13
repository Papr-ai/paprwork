# Mini-App Three-Layer Runtime Architecture

**Status:** In progress (2026-07-09)  
**Related:** `docs/PAPR_CLOUD_RUNTIME_PLAN.md` §2d–2e, `docs/CLOUD_AGENT_GATEWAY_PLAN.md`

---

## Problem

Mini-apps today expose three backend primitives with **different rules** (`/api/db/*`, `/api/jobs/run`, `/api/bash/run`). Agents pick the wrong one (bash + `/tmp` IPC), share links block jobs but allow bash, and users expect: **“if I shared the app, it works.”**

---

## Target model (three layers)

```
apps/{appId}/
├── index.html, app.ts, …     # LAYER 1 — Frontend (browser)
├── backend/
│   ├── manifest.json         # LAYER 2 — App backend (isolated handlers)
│   └── *.py | *.ts           #   Fast, share-link safe, vault keys server-side
└── (linked Jobs/{jobId}/)    # LAYER 3 — Workspace jobs (GKE sandbox)

Jobs/                         # Also LAYER 3 — schedules, agent jobs, heavy ETL
```

### Layer 1 — Frontend

**Allowed from browser:**

| API | Purpose |
|-----|---------|
| `POST /api/db/query`, `/api/db/write`, `/api/db/exec` | Linked Turso / SQLite data |
| `POST /api/app/backend/:action` | App-defined backend handlers |
| `POST /api/jobs/run` | Trigger sandbox jobs (normal — not an exception) |
| `GET /api/jobs/list`, `/api/jobs/status/:id` | Job discovery / polling |
| `fetch(thirdPartyUrl)` | **Only** intentionally public keys (publishable tokens) |

**Blocked from browser:**

| API | Replacement |
|-----|-------------|
| `POST /api/bash/run` | Backend action or job |

Agent desktop **bash tool** (not HTTP) remains for development; mini-app iframe must not call bash.

### Layer 2 — App backend (NEW)

- **Convention:** `apps/{appId}/backend/` — explicit server folder (like Vercel `api/`, not auto-detected)
- **Registration:** `backend/manifest.json` lists named actions → handler files
- **Frontend:** everything outside `backend/` is browser code (transpiled/served as static assets)
- **Cloud execution:** handlers bundled at publish (`backend/bundle.json`), loaded from git cache on **Cloud App Host**, `python3` subprocess at the edge. Vault keys via memory `vault-resolve` only (one hop, no secrets stored on edge).
- Owner/user vault keys injected server-side (catalog-scoped)
- **Works on share links** — same as Vercel serverless routes

### Layer 3 — Workspace jobs (existing)

- `Jobs/{id}/` — Python, bash, node, **agent** jobs
- Runs in **GKE sandbox** (git clone, `$JOB_DIR`, Turso bookends)
- Mini-apps trigger via `/api/jobs/run` + poll DB or job events
- **Works on share links** for anyone with app read access

---

## Execution tiers (cloud)

| Tier | Where it runs | Isolation | Use |
|------|---------------|-----------|-----|
| **app backend** | **Cloud App Host** (`apps.papr.ai`) — `python3` subprocess at edge | Temp dir per invoke; handlers from cached git bundle | `backend/*.py` via `/api/app/backend/:action` |
| **vault-resolve** | Memory server only | Secrets never on edge | One hop for key injection |
| **job-run** | Memory → GKE sandbox | Full git clone sandbox | `Jobs/` agent/heavy ETL |
| ~~bash-run~~ | ~~disabled~~ | — | Removed from mini-apps |

---

## Share link policy (updated 2026-07-09)

| Route | Share link (`?t=…`) |
|-------|---------------------|
| `/api/db/query` | ✅ if `canRead` |
| `/api/db/write` | ✅ if `canWrite` |
| `/api/app/backend/:action` | ✅ if `canRead` |
| `/api/jobs/run`, `/api/jobs/list` | ✅ if `canRead` |
| `/api/bash/run` | ❌ blocked for all mini-app clients |

Vault: owner-scoped keys available to backend/jobs on share links; user-scoped keys require Papr sign-in.

---

## Backend manifest schema (v1)

Path: `apps/{appId}/backend/manifest.json`

```json
{
  "version": 1,
  "actions": {
    "fetch-attention-calls": {
      "handler": "fetch_attention_calls.py",
      "runtime": "python",
      "keys": ["RR_ATTENTION_API_KEY"],
      "timeoutMs": 120000,
      "description": "Fetch Attention calls into app DB cache"
    }
  }
}
```

Frontend:

```typescript
await fetch("/api/app/backend/fetch-attention-calls", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ appId: APP_ID, params: { page: "1" } }),
});
```

---

## Implementation checklist

### Phase A — Policy alignment (paprwork-v2 + memory)

- [x] Document architecture (this file + plan update)
- [x] Block `/api/bash/run` on Cloud App Host + desktop gateway (403 + migration message)
- [x] Remove share-link 403 on `/api/jobs/run` and `/api/jobs/list` (paprwork-v2 + memory)
- [x] Update agent docs (`SystemPrompt`, `APP_AND_JOBS_GUIDE`)

### Phase B — App backend surface (paprwork-v2)

- [x] `src/core/types/appBackend.ts` — manifest types
- [x] `src/gateway/services/appRuntime/appBackendManifest.ts` — parse/validate
- [x] `POST /api/app/backend/:action` on Cloud App Host (edge subprocess)
- [x] `POST /api/app/backend/:action` on desktop gateway (local subprocess)
- [x] `CloudAppBackendService` + `appBackendRunner.ts`
- [x] Rate limits + ACL (`canRead`)

### Phase C — Edge execution (replaces memory action-run)

- [x] `CloudAppBackendService` — load manifest + handler from git cache, run at edge
- [x] `buildAppBackendBundle()` at publish time
- [x] Memory `action-run` removed (vault-resolve + repo-file only)
- [x] Unit tests (`tests/app-backend-manifest.test.ts`, `tests/mini-app-backend-build.test.ts`)
- [x] E2E script `test-cloud-app-backend-e2e.mjs` (requires deployed cloud host)

### Phase D — Agent tooling

- [x] `create_app` scaffolds `backend/manifest.json` + `ping.py` handler
- [x] System prompt: frontend → db + backend + jobs; never bash
- [x] Validator: flag `fetch('/api/bash/run')` in app source

### Phase E — Publish-time optimization

- [x] Bundle backend handlers at republish (`backend/bundle.json` with SHA256 fingerprints)
- [x] Run subprocess on Cloud App Host (edge execution)
- [x] Block `backend/` from static HTTP serving
- [ ] Migrate Attention Workbench to backend action + jobs for agent steps

---

## Repository ownership

| Work | Repo |
|------|------|
| Cloud App Host routes, edge backend execution, publish bundle, manifest types, agent docs | **paprwork-v2** |
| `vault-resolve`, `repo-file`, job-run sandbox, publish registry | **memory** |
| Auth0 / dashboard | papr-dev-platform |

---

## Migration notes for existing apps

1. Replace `fetch('/api/bash/run')` with backend action or `/api/db/*`.
2. Keep `fetch('/api/jobs/run')` for sandbox/agent work — now works on share links.
3. Attention pattern: backend action OR job → write app DB (backend gets `APP_DB` / Turso env injected) → UI reads `/api/db/query`.
