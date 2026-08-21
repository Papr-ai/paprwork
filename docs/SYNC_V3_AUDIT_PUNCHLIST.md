# Sync V3 — Consolidated Audit Punch-List

**Date:** 2026-08-18  
**Scope:** Six audits (cross-cutting + Phases 2–4, first pass + deep). Assume writer + memory server deployed; no fallback-path review.  
**Verdict:** Happy-path V3 logic is substantially correct. Aug-18 WAL corruption class is eliminated on hot paths. Every **Critical** finding is coordination (locks, leases, atomic seq) or failure-path handling (swallowed errors, destructive drains, fire-and-forget writes).

---

## Already verified good (do not re-audit)

| Finding | Evidence |
|---------|----------|
| **Aug-18 corruption class dead** | `TursoLinkedDbWatcher` → workspace log ship, not table-copy overwrite. `pushLocalDbToTurso` / `pullTursoToLocalDb` delegate to `workspaceLogSync.js` (`tursoSyncBridgeCore.ts:781–911`). `pullTursoToLocalDb` only creates empty placeholder if missing (`:901–903`). Bookends use log (`syncJobTursoBookends.ts:60–61`). `backupLocalJobDb` / `restoreLocalJobDb` exist but have **no callers** in `src/` (dead helpers). |
| **`jobs/` vs `Jobs/` path convention** | Repo emission: `collectAppOpFiles.ts:119` → ``jobs/${jobId}/``. Local sync-state bookkeeping only: `resolveWriterSyncedLocalPaths` → `Jobs/{id}` (`:336`). Phase 4 deep **false alarm** on repo paths. |
| **parentHash + abuseFilter + outbox ordering** | Phase 2 deep: core spine healthy; 16/16 targeted tests pass when run. |
| **Git push non-ff retry** | **Already implemented** — `githubWorktree.ts:102–119` (fetch + rebase + retry ×3). Phase 2 deep report was **stale** on this point. |
| **Deploy pins (stopgap)** | **Already in deploy script** — `scripts/deploy-cloud-app-repo-writer.mjs:92–93` sets `--concurrency=1 --max-instances=1`. Still need distributed lock before scaling beyond one instance. |

---

## Severity-ordered implementation punch-list

### P0 — Deploy blockers

#### P0-1 Commit Sync V3 work (both repos)
- **Severity:** Critical  
- **Status:** Open — ~156 dirty paths in `paprwork-v2`; memory server similarly uncommitted per audit.  
- **Why:** No review, backup, or reproducible deploy without commit + PR.  
- **Action:** Commit + PR tonight before further implementation.

#### P0-2 Writer concurrency beyond single instance
- **Severity:** Critical (when scaling); mitigated at concurrency=1  
- **Status:** ✅ Fixed (2026-08-18)  
- **Fix:** Mongo distributed writer lease via memory server (`app_repo_writer_lease.py` + `/v1/cloud/apps/{appId}/writer-lease/*`); `withDistributedAppRepoLock` composes with in-process mutex. Returns 423 on contention. Deploy pins remain until multi-instance soak test.  
- **Files:** `memory/services/app_repo_writer_lease.py`, `memory/routers/v1/cloud_routes.py`, `distributedRepoLock.ts`, `AppRepoWriterService.ts`

#### P1-5 CDC trigger install race (bash-sqlite bypass)
- **Severity:** High  
- **Status:** ✅ Fixed (2026-08-18)  
- **Fix:** `_papr_sync_infra` DB marker (`cdc_triggers_v1`); `ensureLocalDbChangeLogReady` verifies marker + triggers before skipping.  
- **Files:** `tursoSyncLog.ts`, `tursoSyncBridgeCore.ts`

#### P0-3 Atomic workspace-log seq assignment
- **Severity:** Critical  
- **Status:** ✅ Already fixed in memory tree  
- **Evidence:** `workspace_log_service.py:164–209` — atomic `INSERT…SELECT COALESCE(MAX(seq),0)+1 … RETURNING seq` + retry loop.

#### P0-4 Shared scheduler run lease (desktop ↔ cloud double-fire)
- **Severity:** Critical  
- **Status:** ✅ Fixed (2026-08-18)  
- **Fix:** Slot-scoped Mongo lease `{org}:{ns}:{user}:{jobId}:{dueAt}` + `runId` + TTL. Desktop acquires via `jobSchedulerRunLease.ts` before `runJobFromScheduler`; cloud uses same lease in `_run_scheduled_job`.  
- **Files:** `memory/services/job_scheduler_run_lease.py`, `memory/routers/v1/cloud_runtime_routes.py`, `cloud_scheduler_service.py`, `JobsScheduler.ts`, `jobSchedulerRunLease.ts`

#### P0-5 Idempotent workspace-log replay
- **Severity:** Critical  
- **Status:** ✅ Fixed (2026-08-18)  
- **Fix:** `_papr_materialized(replica_id, seq)` gate on Turso + local SQLite; replay-safe SQL enforcement rejects increment-style UPDATE at `/api/db/write`.  
- **Files:** `workspace_log_service.py`, `workspaceLogMaterialized.ts`, `LogMaterializer.ts`, `replaySafeSql.ts`, `gateway/index.ts`

#### P0-6 `__conflicts__/` repo artifacts — spec decision
- **Severity:** Medium (spec clarity)  
- **Status:** ✅ Resolved — **do not implement** filesystem `__conflicts__/` folder  
- **Decision:** Writer conflicts are HTTP **409 JSON** (`appRepoWriterOps.ts` `artifacts[]`), not git tree paths. Surface via coordinator + outbox dead-letter + in-memory ring (`writerConflict.ts`, now persisted to `$PAPR_HOME/data/writer-conflicts.jsonl`).

---

### P1 — High (data loss / silent divergence)

#### P1-1 Heartbeat vs SSE destructive drain (`pendingCloudRuns`)
- **Severity:** High (data loss)  
- **Status:** ✅ Fixed (2026-08-18)  
- **Fix:** Memory heartbeat uses `peek_notifications` (non-destructive). Desktop heartbeat consumes body as text only — SSE is sole drain consumer.  
- **Files:** `memory/services/cloud_run_notifications.py`, `memory/routers/v1/cloud_runtime_routes.py`, `cloudSyncHeartbeat.ts`

#### P1-2 Metadata dual-write fire-and-forget
- **Severity:** High  
- **Status:** ✅ Fixed (2026-08-18)  
- **Fix:** Failed uploads enqueue to `metadata-outbox.jsonl`; heartbeat calls `retryPendingMetadataUploads()`.  
- **Files:** `metadataOutbox.ts`, `MetadataRegistryClient.ts`, `cloudSyncHeartbeat.ts`

#### P1-3 Outbox crash safety + head-of-line blocking
- **Severity:** High  
- **Status:** ✅ Fixed (2026-08-18)  
- **Fix:** `writeFileAtomic` for outbox rewrites; `dead_letter` status; permanent 4xx/409 → dead-letter (no HOL block).  
- **Files:** `SyncOutbox.ts`, `pushAppViaWriterOps.ts`, `writerOutboxErrors.ts`

#### P1-4 Conflict surfacing to users
- **Severity:** High  
- **Status:** ✅ Fixed (2026-08-18)  
- **Fix:** `AppOpsConflictError` propagated with `kind: conflict` + paths; auto-flush skips retry on 409; UI copy via coordinator + `/api/sync/items`.  
- **Files:** `SyncCoordinator.ts`, `CloudSyncService.ts`, `coordinatorStatusReport.ts`, `gateway/index.ts`

---

### P2 — Medium (scale / correctness / contract)

| ID | Issue | Evidence | Fix |
|----|-------|----------|-----|
| P2-1 | SSE reconnect polling | 30s idle terminate + 5s reconnect (`runtimeDispatchSubscriber.ts`) | Long-lived SSE or explicit backoff policy |
| P2-2 | Cloud scheduler O(all users) scan | 60s tick scans all active users | Index/query on `nextRunAt` |
| P2-3 | Contract schemas unwired | Zod schemas tested against literals; no gateway route imports | Wire handlers to frozen contract |
| P2-4 | Fanout ordering | `rememberEvent` before confirmed webhook delivery | Mark delivered after ack |
| P2-5 | Cursor not read on startup | Cursor file written but not read back | Read persisted cursor on subscriber start |
| P2-6 | HLC dead code | Stored, never read for ordering | Use or delete; document seq-only ordering |
| P2-7 | Genesis rollback doc wrong | §3.4 claims fingerprint rollback; path unconditionally delegates to log | Rewrite §3.4: rollback = re-run genesis |
| P2-8 | LogMaterializer + genesis tests missing | Zero coverage on load-bearing files | Add unit + integration tests |

---

## Cross-phase theme

```
Happy path:     ████████████████████  (correct)
Coordination:   ████░░░░░░░░░░░░░░░░  (locks, leases, atomic seq)
Failure paths:  ███░░░░░░░░░░░░░░░░░  (swallowed errors, destructive drains)
```

Two bug families cover all Critical/High items:
1. **Missing coordination primitive** — writer lock, log seq, scheduler lease  
2. **Failure-path handling** — conflicts, dual-write, queue drain, outbox atomicity, replay idempotency

---

## Recommended implementation order

| Night | Items | Effort | Unblocks |
|-------|-------|--------|----------|
| **Tonight** | P0-1 commit both repos | 30–60 min | Everything |
| **Tonight** | P0-3 atomic seq (memory) | ~1 hr | Log integrity |
| **Tonight** | P1-3 outbox temp+rename + dead-letter | ~2 hr | Crash-safe offline queue |
| **This week** | P0-4 shared scheduler lease | 1–2 days | Double-fire |
| **This week** | P1-1 single patch consumer | 0.5–1 day | Patch loss |
| **This week** | P1-4 conflict IPC + no 409 auto-retry | 0.5–1 day | User-visible conflicts |
| **Before scale** | P0-2 distributed lock | 1 day | Multi-instance writer |
| **Before prod genesis** | P0-5 idempotent replay policy | 1–2 days | Replay safety |
| **Before prod genesis** | P1-5 trigger install at link-time | 0.5 day | CDC completeness |

**Do not deploy writer to prod at default Cloud Run concurrency** until P0-2 stopgap confirmed in the live deploy command (script has pins; verify the running service matches).

---

## Audit corrections (reports vs current tree)

| Audit claim | Current reality |
|-------------|-----------------|
| No git push retry | **Wrong** — `githubWorktree.ts:102–119` has retry loop |
| Deploy script missing concurrency pins | **Wrong** — `deploy-cloud-app-repo-writer.mjs:92–93` |
| `collectAppOpFiles.ts:336` emits `Jobs/` to repo | **Wrong** — local bookkeeping only; repo uses `jobs/` at `:119` |
| `flushAppNow` swallows `AppOpsConflictError` | **Fixed** — rethrows at `:79–83`; background/coordinator paths still weak |
| Redis lock "in production deploy" | **Still true** — comment only in `repoLock.ts:2` |

---

## Test gates (re-run before prod)

```bash
nvm use 24
npm run type-check
# Unit bundle (36 tests when last run):
npx vitest run tests/cloud-sync-hardening.test.ts tests/sync-v3-heartbeat.test.ts \
  tests/app-repo-writer-ops.test.ts tests/push-app-via-writer-ops.test.ts

PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001 npm run test:sync-v3-e2e
npm run test:app-repo-writer
npm run test:sync-v3-writer
```

**Gaps to add:** LogMaterializer, workspace-log genesis cutover, multibyte parentHash fixture.

---

## References

- Implementation plan: `docs/SYNC_V3_IMPLEMENTATION_PLAN.md`
- Sync contract: `docs/SYNC_CONTRACT.md`
- Agent transcripts: six audit reports on delegation cards (2026-08-18)
