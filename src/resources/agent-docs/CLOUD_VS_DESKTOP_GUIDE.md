# Cloud vs Desktop — Agent Guide

**Audience:** Paprwork agent (system context)  
**Last updated:** 2026-07-01

Use this guide when users ask about running jobs while their Mac is asleep, what syncs automatically, and what still requires the local app.

---

## Architecture in one sentence

**Desktop gateway when awake; Papr Cloud when the desktop heartbeat is stale.** Same agent stack in cloud (Mastra / pi-ai / tools), different runtime (no Electron, ephemeral workspace per run).

---

## Three sync lanes (do not conflate)

| Lane | What moves | Cloud writes | Desktop reads (on wake) |
|------|------------|--------------|-------------------------|
| **Git** | Apps, `Jobs/`, `data/jobs.json`, `workspace/` | Memory server git writeback after runs | `CloudSync.pullNow()` via heartbeat |
| **Turso** | Job/app `data.db` user tables | Gateway pull → run → push bookends | `syncTursoAfterCloudRun()` on wake (default **on**; set `TURSO_PULL_AFTER_CLOUD_RUN=false` to disable) |
| **Chat** | Main chat history | Ephemeral job sessions in cloud | `~/.paprwork-v2/chats.db` (local-first, not in git) |

**Published mini-apps** on `apps.papr.ai` read Turso directly — they see DB changes as soon as cloud pushes Turso, without waiting for desktop pull.

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
- Vault sync: LLM keys + Papr API key available in cloud vault
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

**Yes, on wake — but not automatic by default today.**

Flow:

1. Cloud gateway: Turso **pull** before run → local `data.db` in temp workspace
2. Agent/job writes SQLite during run
3. Cloud gateway: Turso **push** after run
4. Desktop wake: `handlePendingCloudRuns()` → `syncTursoAfterCloudRun()` → pulls linked sources into local `~/Papr/Jobs/{id}/data/data.db`

**Default:** Turso pull on wake is **enabled**. Set `TURSO_PULL_AFTER_CLOUD_RUN=false` on the desktop gateway to disable.

**Published cloud apps:** read Turso live — no desktop pull needed for those UIs.

**Unpublished local mini-apps:** need Turso pull on desktop to see cloud-written rows.

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
| **Plans** | `~/Papr/data/plans.db` — local SQLite, not in cloud git repo |
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
3. ~~**`TURSO_PULL_AFTER_CLOUD_RUN` by default**~~ — ✅ enabled unless `false`
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

## Related docs

- `docs/CLOUD_AGENT_GATEWAY_PLAN.md` — full lifecycle
- `docs/PAPR_CLOUD_RUNTIME_PLAN.md` — scheduler, heartbeat, sandboxes
- `src/resources/agent-docs/APP_AND_JOBS_GUIDE.md` — job creation patterns
