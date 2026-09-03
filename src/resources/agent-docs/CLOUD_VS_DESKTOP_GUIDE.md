> **Paths:** `$PAPR_HOME` = active org/namespace workspace (`~/Papr/orgs/{orgId}/namespaces/{nsId}/`). See `docs/PAPR_WORKSPACE_PATHS.md`. Prefer app/job tools over raw paths.

# Cloud vs Desktop — Agent Guide

**Audience:** Paprwork agent (system context)  
**Last updated:** 2026-08-26

Use this guide when users ask about running jobs while their Mac is asleep, what syncs automatically, and what still requires the local app.

**Canonical terms (use consistently):**
- **Cloud Sync** — Settings toggle; enables git push, Turso replica sync, vault push, and auto-publish
- **Upload now** — UI button; same engine as `push_cloud_sync({ appId })` (git **+** Turso ordered flush)
- **Cloud vault** — Integration Keys + platform cookies on the memory server; cloud jobs read vault, **not** desktop keychain
- **Plan A replica** — Registry DB sync mode (`syncMode: "replica"`); Turso primary is authority; desktop tails frames via `papr_db_pull`
- **Sync V3** — Per-app GitHub writer repo for app source (not namespace monorepo `apps/` paths)

---

## Architecture in one sentence

**Desktop gateway when awake; Papr Cloud when the desktop heartbeat is stale.** Same agent stack in cloud (Mastra / pi-ai / tools), different runtime (no Electron, ephemeral workspace per run).

---

## Three sync lanes (do not conflate)

| Lane | What moves | Cloud writes | Desktop reads (on wake) |
|------|------------|--------------|-------------------------|
| **Git (app code — Sync V3)** | App source + linked `jobs/{id}/` at **per-app repo root** | Writer ops via [`finalizeAppRepoMutation`](../src/gateway/services/syncV3/finalizeAppRepoMutation.ts) — desktop flush **and** cloud sandbox debounced push | Revision subscriber + `pullAppCodeFromRepo` |
| **Git (legacy namespace)** | `data/jobs.json`, `workspace/` scaffold | Memory server git writeback for workspace-chat bootstrap only — **not** app source | Heartbeat pull |
| **Turso (Plan A replica)** | Registry + linked job DB user tables | Turso **primary** authority; cloud gateway writes primary directly | Desktop embedded replica: `papr_db_pull` / heartbeat → `pull()` tails frames; offline writes queue → `papr_db_push` on reconnect |
| **Chat** | Main chat history | Ephemeral job sessions in cloud | `~/.paprwork-v2/chats.db` (local-first, not in git) |

**Agent trap — namespace git vs per-app repo:** Local `git ls-files apps/{appId}/` reads the **legacy namespace monorepo**. Sync V3 app code is **not** uploaded there. Always use `get_cloud_sync_status({ appId })` → `appWriterRepo` (clone URL, last commit, Sync V3 status) or `inspect_cloud_repo({ appId, action: "list"|"read" })` to verify cloud app files.

**Published mini-apps** on `apps.papr.ai` read Turso directly — they see DB changes as soon as cloud pushes Turso, without waiting for desktop pull.

---

## Q: Published app "Run now" — does desktop need to be awake?

**No.** When a visitor or owner clicks **Run now** in a published mini-app (or share link), the app calls `POST /api/jobs/run` on **Cloud App Host** (`apps.papr.ai`). That runs python/node/bash/agent jobs in a **cloud sandbox** — same job types as desktop, different runtime.

| Requirement | Why |
|-------------|-----|
| Job code in **per-app GitHub repo** (`jobs/{jobId}/`) | Cloud reads from synced repo, not local `$PAPR_HOME/Jobs/` |
| Integration keys in **cloud vault** | Desktop keychain is unavailable when Mac is asleep |
| Job not `local-only` / LinkedIn CDP | Requires desktop browser session |

**Do not** tell users to wake Paprwork for published-app Run now failures — debug with `inspect_cloud_repo`, vault/catalog keys, and `query_cloud_turso`.

**Different path — scheduled jobs:** Memory scheduler + `desktopHeartbeat` / `pendingCloudRuns` applies when **cron/interval** jobs defer to desktop or queue while asleep. See scheduler section below.

**Bulk DB from mini-apps (desktop + cloud):** `POST /api/db/batch` = reads only; `POST /api/db/write-batch` = up to 25 writes (optional `atomic: true`). Same endpoints on `apps.papr.ai`.

---

## Q: Do users/agents need to do anything for cloud agent jobs?

**Mostly no — per run.** Once infrastructure is wired:

1. User has Cloud Sync + vault keys synced while desktop was awake
2. Memory scheduler sees stale desktop heartbeat (Mac asleep / app quit)
3. Memory prepares run context (repo token, Turso creds, vault LLM auth)
4. Memory calls **Cloud Agent Gateway** → same `runIsolatedJobSession` as desktop
5. Agent uses tools, can write `JOB_DB` / `APP_DB` → Turso push at end
6. Memory writebacks `jobs.json` on GitHub

**User/agent does NOT pick “run in cloud” per job** — routing is automatic from schedule + heartbeat.

**Exception — manual cloud test (desktop awake):** Users can click **Run in Cloud** in Jobs UI, or agents can call `run_job({ jobId, runtime: "cloud" })`. This pushes git, runs via `POST /v1/cloud/runtime/job-run`, appends logs locally, then pulls git + Turso. Use this to verify cloud execution without putting the Mac to sleep.

**Prerequisites (one-time / while awake):**

- Cloud Sync enabled; workspace pushed to GitHub cloud repo
- **Vault sync:** Integration Keys and Platform Connection cookies push to the **cloud vault** when desktop syncs while awake — cloud jobs cannot read local keychain directly
- Production: `CLOUD_AGENT_GATEWAY_URL` + matching `PAPR_CLOUD_AGENT_GATEWAY_KEY` on memory server; gateway deployed to Cloud Run
- Job definition + code already in cloud git repo (not only on local disk)

**If local edits never pushed before sleep:** cloud runs the **old** GitHub version.

---

## Q: Scheduler sync — local vs cloud, duplicate runs?

**Not a shared live scheduler.** Coordination model:

| State | Who runs scheduled jobs |
|-------|-------------------------|
| Desktop awake (heartbeat fresh ~60s) | **Local** `JobsScheduler` — cloud scheduler **defers** |
| Desktop asleep / no heartbeat | **Cloud** memory scheduler |

**After cloud run:** memory updates `jobs.json` (`lastRunAt`, status, output) via git writeback. On wake, desktop heartbeat receives `pendingCloudRuns` → pulls git (+ optional Turso).

**Local priority when awake:** yes. Fresh heartbeat = cloud does not schedule that user's jobs.

**Duplicate-run edge case:** if desktop wakes before git pull completes, local scheduler might still see pre-run `jobs.json` briefly. Mitigated by pull on heartbeat; not a hard distributed lock.

**Agents should not manually “run this in cloud” for production scheduling.** Use normal job scheduling; the platform routes. For **testing** cloud behavior while awake, use `run_job({ runtime: "cloud" })` or the Jobs UI **Run in Cloud** button.

---

## Q: Turso updated in cloud — does local SQLite update?

**Yes, on wake — via Plan A embedded replica pull (not legacy sync-index CDC).**

Flow (registry DBs with `syncMode: "replica"`):

1. Cloud gateway: writes go to Turso **primary** (direct adapter or replica service online path)
2. Agent/job writes during cloud run land on primary
3. Desktop on wake: heartbeat / manual sync runs **`papr_db_pull`** (or app Upload now / `push_cloud_sync` pull-before-push bookends) → local embedded replica tails new frames
4. Agent tools: `papr_db_sync_status` shows `online`, `pendingPush`, `migrationConflict` — use `papr_db_push` / `repair_cloud_sync` when blocked

**Legacy path (`syncMode: "legacy"`):** still uses CDC + optional `sync-index` polling until cutover. Prefer replica tools when status shows `syncMode: "replica"`.

**Published cloud apps:** read Turso primary live — no desktop pull needed for those UIs.

**Unpublished local mini-apps:** need desktop replica pull (or open app after sync) to see cloud-written rows in local SQLite.

---

## Q: What context do cloud agent jobs have?

### ✅ Available in cloud gateway runs

| Resource | How |
|----------|-----|
| **Git repo clone** | Full `PAPR_HOME`: `Jobs/`, `apps/`, `data/jobs.json`, `workspace/` |
| **Tools (most)** | bash, filesystem, papr_memory, appJobs, planning, etc. — same registry |
| **Skills** | Bundled `preloaded-*` skills in gateway image; `read_skill` works |
| **Workspace files** | `MEMORY.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`, `BRAND.md`, daily logs — if synced under `workspace/` in git |
| **JOB_DB / APP_DB** | Env vars + Turso bookends |
| **LLM auth** | Vault-resolved API keys / OAuth tokens (if previously synced from desktop) |
| **Papr Memory API** | `search_agent_memory`, `add_agent_memory`, schemas, etc. via `PAPR_API_KEY` |

### ⚠️ Partial / gaps in cloud today

| Resource | Gap |
|----------|-----|
| **Sleep / Wiki preflight** | Desktop `AgentJobExecutor` injects chat summaries + job activity before run. Cloud gateway receives prompt from memory server **without** that preflight unless memory adds it. Sleep job may miss recent chat context in cloud. |
| **Main chat history** | Lives in `~/.paprwork-v2/chats.db` — **not** in git. Cloud job sessions are isolated `job:{id}:{runId}`. No access to desktop chat threads unless via Papr Memory search tools. |
| **Plans** | `$PAPR_HOME/data/plans.db` — local SQLite, not in cloud git repo |
| **Subagent profiles** | From repo — planned, not fully wired in cloud prep |
| **Code index / hybrid grep** | Desktop file watcher + Papr Memory code schema — not in cloud gateway |
| **Custom keys at runtime** | Only keys already in vault; no keychain / no new `request_key` UI |
| **Delegation UI** | Subagent jobs can run batch-style; no live MiniChatCard |

### ❌ Not available in cloud

- **Ollama** (local only)
- **Electron IPC** (`window.paprAPI`, attachments, permission prompts)
- **Browser automation** — ✅ Playwright Chromium in cloud agent gateway container
- **Unpublished mini-apps** in Electron tabs (published `apps.papr.ai` ✅)
- **CloudSync push** from cloud gateway (by design — memory owns git writeback)

---

## Q: What's still missing (priority list)

### P0 — Required for production parity

1. **Deploy Cloud Agent Gateway** + set `CLOUD_AGENT_GATEWAY_URL` on memory server
2. ~~**Playwright in gateway container**~~ — ✅ `Dockerfile.cloud-agent-gateway` (bookworm + Chromium)
3. ~~**Turso pull on cloud run wake**~~ — ✅ Plan A replica pull on heartbeat + `papr_db_pull` (legacy sync-index still for `syncMode: "legacy"`)
4. **Sleep/Wiki preflight in cloud path** — memory or gateway must inject same context as `AgentJobExecutor`

### P1 — Important gaps

5. Memory `sessions/stream` → gateway SSE (cloud chat while browser-only)
6. `record_cloud_job_run` + desktop notification parity after cloud runs
7. **WorkspaceService / PlanService** use `getPaprRoot()` — cloud multi-run containers need singleton reset per run
8. OAuth token refresh in cloud (v1: desktop re-pushes vault)
9. Subagent profiles loaded from repo in cloud prep

### P2 — Future

10. Delegation nested cloud runs (v2)
11. MCP bridge (cloud compute + local tools)
12. Full Papr Web chat (Phase 5)
13. Shallow clone caching per user

---

## Agent decision tree

```
User asks to run something while Mac might be asleep
│
├─ Is it a scheduled job already in jobs.json + GitHub?
│   └─ YES → Explain it runs automatically in cloud when asleep (if vault + sync OK)
│
├─ Did they edit job locally today?
│   └─ YES → Remind: push/sync while awake or cloud runs old version
│
├─ Does job need browser / Ollama / desktop chat history?
│   └─ YES → May fail or be incomplete in cloud until gaps closed
│
├─ Does job write SQLite user tables?
│   └─ YES → Turso push in cloud ✅; desktop sees data after wake + Turso pull
│
└─ Published app should show new data?
    └─ YES → Turso push is enough; app reads cloud DB directly
```

---

## Fork install and contribute-back

| Role | Action | Tools |
|------|--------|-------|
| **Publisher** | Share with `codeAccess=install` via `publish_cloud_app` | Others install with `install_cloud_app` |
| **Contributor** | Edit local fork; propose changes | `submit_cloud_app_change` → GitHub PR on owner's papr-work repo |
| **Owner** | Review incoming PRs | `list_cloud_app_changes` → `resolve_cloud_app_change({ action: "approve"|"reject" })` |

Approve **merges the PR on GitHub** (via Papr GitHub App), then the owner's desktop runs `pullNow()` — there is no copy-from-contributor-folder merge on the owner's machine. Details: `docs/SYNC_CONTRACT.md` §6.

---

## Related docs

- `docs/CLOUD_AGENT_GATEWAY_PLAN.md` — full lifecycle
- `docs/PAPR_CLOUD_RUNTIME_PLAN.md` — scheduler, heartbeat, sandboxes
- `src/resources/agent-docs/APP_AND_JOBS_GUIDE.md` — job creation patterns
