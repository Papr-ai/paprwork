# Cloud Agent Gateway — Comprehensive Plan

**Status:** Phase 1–2 deployed (2026-07-03) — direct + via-memory E2E ✅; CI hardening live on memory `main`  
**Goal:** Cloud agent/subagent jobs and chat sessions use the **same Mastra / pi-ai / tool loop** as desktop, with **SQLite → Turso** durability and **git writeback**, when the Mac is asleep or Papr Web runs in the browser.

---

## Live deployment (2026-07-03)

| Component | Value |
|-----------|--------|
| Gateway service | `papr-cloud-agent-gateway` (Cloud Run, `us-west1`) |
| Gateway URL | `https://papr-cloud-agent-gateway-7dckb3v3oa-uw.a.run.app` |
| Gateway revision | `00005` (image `70f8dd1-pw3` — git, python3, Playwright Chromium) |
| GCP project | `gen-lang-client-0873281406` |
| Shared secret | `papr-cloud-agent-gateway-key` (Secret Manager) |
| Memory prod URL | `memory.papr.ai` → `memoryserver-staging` |
| Memory active revision | `memoryserver-staging-00163-ggw` (env wired ✅) |
| Auth model | `--no-allow-unauthenticated` + `X-Cloud-Agent-Gateway-Key` + **Google identity token** |

### E2E status

| Test | Result |
|------|--------|
| Direct gateway bash (`--e2e-prompt`) | ✅ ~8s |
| Direct gateway browser (`--browser-e2e`) | ✅ ~13s |
| Full stack `--via-memory` (`memory.papr.ai`) | ✅ ~11s, `backend: cloud-agent-gateway` |

**Fix deployed:** `memory/services/cloud_agent_gateway_client.py` — metadata server + `fetch_id_token` for Cloud Run audience. `cloud_job_runner_service.py` — preserve `backend: cloud-agent-gateway` in job-run response (`afb2c45`).

---

## Problem statement

| Capability | Desktop gateway | Cloud today |
|------------|-----------------|-------------|
| Agent tool loop (Mastra / pi-ai) | ✅ | ✅ (gateway deployed) |
| OAuth → pi-ai routing | ✅ | ✅ (vault `source: oauth`) |
| bash / filesystem / memory tools | ✅ | ✅ |
| Writes to `data/data.db` | ✅ | ✅ (Turso bookends in gateway) |
| Turso push after run | ✅ | ✅ |
| Git writeback (`jobs.json`, code) | ✅ via CloudSync | ✅ via memory (metadata) |
| Desktop wake sync | ✅ heartbeat + pull | partial |
| Browser (Playwright) | ✅ | ✅ (Chromium in image) |
| Vault keys for `${KEY}` in bash/jobs | ✅ Keychain | ✅ `vaultKeys` in prepare + gateway env |

Agents are designed to **write SQLite** (bash + `sqlite3`, job scripts, app-linked `APP_DB`). Cloud must preserve:

```
Turso pull → agent/tools write local data.db → Turso push → desktop pull
```

---

## Architecture decision

**Run the gateway in the cloud** (same TypeScript codebase), not a reimplementation on memory server.

```
┌─────────────────────────────────────────────────────────────────┐
│ Memory server (Python) — control plane                          │
│ • ACL, scheduler, heartbeat, billing                            │
│ • materialize user repo (GitHub tarball)                        │
│ • Turso token issuance                                          │
│ • vault read (GCP Secret Manager)                               │
│ • git writeback (jobs.json, commits)                            │
│ • record_cloud_job_run → desktop notification                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │ POST /internal/agent/run
                            │   Authorization: Bearer <identity-token>
                            │   X-Cloud-Agent-Gateway-Key: <shared-secret>
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ Cloud Agent Gateway (Node, Cloud Run) — compute plane           │
│ • Same AgentService + runIsolatedJobSession                     │
│ • Same pi-ai / Mastra routing as desktop                        │
│ • PAPR_HOME = cloned user repo per run                          │
│ • Turso pull/push via tursoSyncBridgeCore                       │
│ • Vault keys + llmAuth injected (no Electron IPC)             │
│ • Returns output + exit code + optional changed paths           │
└─────────────────────────────────────────────────────────────────┘
```

**Not** one gateway per user (cost). **One shared** Cloud Run service, multi-tenant per request with strict ACL headers from memory.

**GKE** remains for **command-job isolation** (bash/python in gVisor). Agent gateway runs on Cloud Run; optionally co-locate in sandbox pod later.

---

## Three sync lanes (do not conflate)

| Lane | What moves | Cloud owner | Desktop owner |
|------|------------|-------------|---------------|
| **Git** | Apps, job code, `data/jobs.json`, source files | Memory writeback after run | CloudSync pull on heartbeat |
| **Turso** | Job/app `data.db` user tables | Gateway pull before / push after agent run | TursoSyncBridge pull after notification |
| **Chat storage** | Agent job session messages | Ephemeral or Papr Memory API | `~/.paprwork-v2/chats.db` (optional) |

CloudSync **push** is disabled in cloud gateway mode — memory owns git commits. CloudSync **pull** on desktop still required after cloud runs.

---

## End-to-end run lifecycle

### Scheduled or API-triggered agent job (Mac asleep)

```
1. Memory scheduler / POST /v1/cloud/runtime/job-run
2. Memory: find job in repo jobs.json
3. Memory: prepare_cloud_agent_run_context()
     • clone URL + short-lived GitHub token
     • job record + subagent profile paths
     • Turso creds for j-{jobId8} (+ linked app sources)
     • vault LLM keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, …)
     • auth metadata (oauth vs apiKey)
     • vaultKeys (all user keys for bash ${KEY} substitution)
4. Memory → Gateway POST /internal/agent/run (+ identity token)
5. Gateway:
     a. Clone full user repo → PAPR_HOME
     b. Turso pull → Jobs/{id}/data/data.db (+ linked sources)
     c. Resolve provider auth → pi-ai or Mastra
     d. runIsolatedJobSession(prompt, provider, model, allowedToolIds)
     e. Turso push (dirty linked sources)
     f. Return { exitCode, output, stderr?, changedFiles? }
6. Memory:
     • _persist_job_result → jobs.json git writeback
     • record_cloud_job_run → pendingCloudRuns
7. Desktop wake:
     • heartbeat drains notification
     • CloudSync.pullNow() (git)
     • syncTursoAfterCloudRun() (data.db)
```

### Chat session (`POST /v1/cloud/runtime/sessions/stream`)

Same gateway path for `provider != cursor`, streaming SSE events (`tool-call`, `text-delta`, …) instead of batch job result. **Gateway SSE endpoint exists; memory proxy not wired yet.**

### Cursor provider

Keep existing **Cursor SDK** path on memory server (already has tool loop). Gateway optional later for unified billing.

---

## Credential model

### Vault sync (already built)

Desktop pushes keychain → GCP SM via `VaultSyncService`. OAuth tokens stored as:

- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` with `source: oauth` in local metadata

### Extensions

| Item | Status |
|------|--------|
| Push `source` + `oauthProvider` in vault sync payload | ✅ |
| `POST /v1/cloud/vault/resolve-auth` on memory | ✅ |
| `vaultKeys` in prepare → gateway `process.env` | ✅ |
| OAuth refresh in cloud | ❌ v2 — desktop re-pushes on refresh |

### Scheduler

- `PAPR_API_KEY` — Papr Memory / tool calls (`search_agent_memory`, etc.)
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from vault — LLM auth (separate from Papr API key)

---

## SQLite write paths agents use (must work in cloud)

| Path | Mechanism | Cloud gateway action |
|------|-----------|----------------------|
| Job scratch tables | `JobDatabase` on run start | Same — local file in workspace |
| User tables in `data.db` | bash `sqlite3 $JOB_DB` | Turso pull/push bookends |
| App-linked DB | `APP_DB` from `data-sources.json` | ✅ `jobAppDatabase.ts` + prepare parity |
| Mini-app `/api/db/*` | DbRouter (desktop only) | N/A in agent jobs — agents use bash/JOB_DB |
| Cloud mini-apps | TursoDbAdapter direct | Different runtime (app host) |

---

## Gateway cloud mode changes

### Entry point

`src/gateway/cloud-agent-gateway.ts` — deployed to Cloud Run:

- Env: `PAPR_CLOUD_AGENT_GATEWAY_KEY`, `PAPR_MEMORY_SERVER_URL`
- HTTP: `POST /internal/agent/run`, `POST /internal/agent/stream`
- No WebSocket UI, no CloudSync push, no JobsScheduler tick

### Environment flags

| Flag | Effect |
|------|--------|
| `GATEWAY_MODE=cloud_agent` | Skip CloudSync init, skip local scheduler, skip Electron permission bridge |
| `PAPR_HOME=/workspace/papr` | Per-run override (set before agent session) |
| `CLOUD_SYNC_ENABLED=false` | Already supported |

### PAPR_HOME refactor

`getPaprRoot()` in `@core/utils/paprRoot.ts` — migrated JobsService, AppService, TursoSyncBridge, bash, jobAppDatabase.

### Vault-backed keys

Run context from memory includes `llmAuth` + `vaultKeys`. Gateway injects into `process.env` for bash/`run_job` `${KEY}` substitution. No IPC.

### Tools — cloud compatibility matrix

| Tool | Cloud gateway |
|------|---------------|
| bash | ✅ scoped to PAPR_HOME |
| filesystem | ✅ scoped to PAPR_HOME |
| papr_memory | ✅ HTTP to memory with user PAPR_API_KEY |
| appJobs / run_job | ✅ runs in same gateway process |
| browser | ✅ Playwright Chromium in gateway container |
| delegation | ⚠️ v2 — nested cloud runs |
| IPC / electron-only | ❌ disabled |

---

## Memory server changes

### Modules

| File | Purpose | Status |
|------|---------|--------|
| `services/cloud_agent_run_prepare.py` | Build run context: repo, job, turso, vault auth, vaultKeys | ✅ |
| `services/cloud_agent_gateway_client.py` | HTTP to gateway (key + identity token) | ✅ (token fix 2026-07-03) |
| `services/cloud_workspace_repo_service.py` | `materialize_full_user_repo()` | ✅ |

### Route changes

| Route | Change | Status |
|-------|--------|--------|
| `POST /v1/cloud/runtime/job-run` | Agent jobs → gateway when `CLOUD_AGENT_GATEWAY_URL` set | ✅ |
| `POST /v1/cloud/runtime/sessions/stream` | Non-cursor → gateway SSE proxy | ❌ |
| `POST /v1/cloud/vault/resolve-auth` | LLM auth for gateway | ✅ |

### CI hardening (memory `.github/workflows/docker-build-gcp.yml`)

On every web + workers deploy:

- `CLOUD_AGENT_GATEWAY_URL` env var
- `PAPR_CLOUD_AGENT_GATEWAY_KEY` secret binding
- `roles/run.invoker` on gateway for `cloud-run-webapp-sa`
- `secretAccessor` on `papr-cloud-agent-gateway-key`

---

## Desktop integration (no changes to agent logic)

| Component | Change | Status |
|-----------|--------|--------|
| `CloudSyncService.handlePendingCloudRuns` | Pull git + Turso after cloud run | ✅ |
| `TURSO_PULL_AFTER_CLOUD_RUN` | Default on; `false` to disable | ✅ |
| `VaultSyncService` | Push auth metadata (`source: oauth`) | ✅ |
| Heartbeat | Unchanged | ✅ |

---

## Deployment

| Service | Image | Env |
|---------|-------|-----|
| `papr-cloud-agent-gateway` | Node 24 + Playwright Chromium | `GATEWAY_MODE=cloud_agent`, secret, memory URL |
| `memoryserver-staging` | Existing Python image | `CLOUD_AGENT_GATEWAY_URL`, same secret |

**Auth (both required):**

1. `Authorization: Bearer <Google identity token>` — Cloud Run IAM (`roles/run.invoker` for memory SA)
2. `X-Cloud-Agent-Gateway-Key` — shared application secret

Script: `scripts/deploy-cloud-agent-gateway.mjs` (default wires `memoryserver-staging`, not workers).

```bash
node scripts/deploy-cloud-agent-gateway.mjs \
  --project=gen-lang-client-0873281406 \
  --region=us-west1 \
  --memory-service=memoryserver-staging
```

---

## Implementation phases

### Phase 0 — Plan ✅

This document.

### Phase 1 — Foundation ✅

- [x] `getPaprRoot()` + migrate JobsService / AppService / TursoSyncBridge
- [x] Vault sync metadata (`source` → GCP label `papr-source`)
- [x] `cloud-agent-gateway.ts` + health + auth middleware
- [x] `CloudAgentGatewayService.runAgentJob()` — clone repo, Turso bookends, full agent loop

### Phase 2 — Full agent loop ✅

- [x] Wire `runIsolatedJobSession` + `authOverride` in gateway
- [x] pi-ai / Mastra routing via vault auth labels
- [x] Turso pull/push bookends
- [x] Memory `cloud_agent_gateway_client` + gateway path in `cloud_agent_job_service`
- [x] Git writeback unchanged on memory side
- [x] `vaultKeys` in prepare + gateway env injection
- [x] Playwright Chromium in gateway image
- [x] Deploy script + direct gateway E2E (bash + browser)
- [x] Memory staging env wired (`memory.papr.ai`)
- [x] CI hardening in memory repo (env + secret + IAM)
- [x] Identity token in memory → gateway client (2026-07-03)
- [x] CI hardening in memory repo (env + secret + IAM on every deploy)
- [x] E2E via-memory path (gateway invoked successfully from `memory.papr.ai`)

### Phase 3 — Streaming & scheduler (partial)

- [x] `POST /internal/agent/stream` SSE (gateway)
- [ ] Memory `sessions/stream` → gateway for openai/anthropic/google
- [x] Scheduler agent jobs use gateway when `CLOUD_AGENT_GATEWAY_URL` set
- [ ] `record_cloud_job_run` + desktop notification parity (verify end-to-end)

### Phase 4 — Parity & hardening (remaining)

- [x] `APP_DB` / `JOB_DB` in cloud agent env
- [ ] Subagent profiles from repo (full parity)
- [x] E2E via-memory path (`backend: cloud-agent-gateway`, revision `00165-vc7`)
- [ ] E2E: agent SQLite row → Turso → desktop pull
- [x] Default Turso pull after cloud run (opt-out via `TURSO_PULL_AFTER_CLOUD_RUN=false`)
- [ ] Optional: agent run inside GKE pod for gVisor isolation
- [ ] OAuth refresh in cloud (refresh tokens in vault)
- [ ] Route `memoryserver-workers-staging` to latest revision (scheduler on web; workers stale)

---

## Test plan

### Direct gateway (works today)

```bash
export PAPR_CLOUD_AGENT_GATEWAY_KEY="$(gcloud secrets versions access latest \
  --secret=papr-cloud-agent-gateway-key --project=gen-lang-client-0873281406)"

node scripts/test-cloud-agent-job-e2e.mjs \
  --gateway=https://papr-cloud-agent-gateway-7dckb3v3oa-uw.a.run.app \
  --e2e-prompt

node scripts/test-cloud-agent-job-e2e.mjs \
  --gateway=https://papr-cloud-agent-gateway-7dckb3v3oa-uw.a.run.app \
  --browser-e2e --e2e-prompt
```

### Full stack via memory (after identity-token deploy)

```bash
node scripts/test-cloud-agent-job-e2e.mjs \
  --memory=https://memory.papr.ai \
  --gateway=https://papr-cloud-agent-gateway-7dckb3v3oa-uw.a.run.app \
  --e2e-prompt --via-memory
```

Pass criteria: log line `memory job-run used cloud-agent-gateway backend` + success output.

### E2E criteria (full parity)

1. Create agent job: "Insert row into JOB_DB test table"
2. Run via cloud while desktop heartbeat stale
3. Verify Turso has row (memory API or mini-app)
4. Wake desktop → heartbeat → local `data.db` has row
5. Verify `jobs.json` lastRunAt writeback on GitHub

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Multi-tenant data leak | Service auth + per-run temp workspace + never reuse PAPR_HOME across concurrent runs |
| OAuth token expiry mid-run | Desktop vault push; v2 refresh in gateway |
| Large repo clone latency | Shallow clone; cache per user (v2) |
| Concurrent jobs same user | Queue per user or isolated temp dirs |
| Tool calls escape workspace | bash/filesystem path guards + `PAPR_HOME` chroot semantics |
| Duplicate git writers | Gateway never pushes git; memory only writeback |
| Gateway 403 from memory | Identity token + run.invoker IAM (CI-enforced) |

---

## Out of scope (v1)

- Ollama in cloud
- MCP bridge (desktop tools while cloud compute)
- Full chat history in cloud SQLite (use Papr Memory or ephemeral)
- Per-user 24/7 gateway VMs

---

## Related docs

- `docs/PAPR_CLOUD_RUNTIME_PLAN.md` — overall cloud runtime
- `docs/TOOL_RESULT_TRUNCATION_STRATEGY.md` — context management (same in cloud)
- `src/gateway/cloud-app-host.ts` — pattern for Cloud Run Node service + memory auth
