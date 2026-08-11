# Event-Driven Turso Sync — Implementation Plan

> **Superseded (2026-08-09):** Mongo heartbeat queue and env flags were dropped. Current model:
> writers bump workspace `sync-index` Turso DB (direct for desktop/cloud-agent; memory HTTP for cloud app host);
> desktop heartbeat polls sync-index via `syncTursoFromSyncIndex()`. See [`SYNC_CONTRACT.md`](./SYNC_CONTRACT.md) §7.

> **Goal:** Replace redundant push/pull hooks with a single event-driven model per direction,
> add cloud Turso `db-changed` → desktop local hydration, and prove via the sequential test
> suite that we do not double-push, overload, or miss registry DBs.

**Companion docs:** [`SYNC_CONTRACT.md`](./SYNC_CONTRACT.md), [`SYNC_ARCHITECTURE_V2.md`](./SYNC_ARCHITECTURE_V2.md)

**Status:** Plan (2026-08-08) — implementation tracked in phases below.

---

## 1. Target architecture

```
LOCAL → CLOUD (push)
  Primary:  TursoLinkedDbWatcher → debounced push queue (60s / 5s completion)
  Explicit: pushNow, pre-cloud-run, job writeDbIds completion
  Safety:   startup dirty recovery, post_git dirty-only enqueue
  Removed:  /api/db/write|exec duplicate scheduleTursoPushForJob

CLOUD → LOCAL (pull)
  Primary:  pendingTursoDbChanges (heartbeat) → scoped reconcile (dbId/jobId)
  UX:       mini-app open debounced pull (remoteAhead skip)
  Safety:   post-git-pull reconcile (remoteAhead skip), wake reconcile (remoteAhead)
  Removed:  syncTursoAfterCloudRun assumeRemoteChanged (keep git pull only on that path)

GIT (unchanged)
  pushNow / pullNow / heartbeat pendingCloudRuns → git only where noted
```

This matches industry hybrid sync: **events for immediacy**, **fingerprints for idempotency**,
**reconciliation when offline or event dropped**.

---

## 2. Phase breakdown

### Phase 1 — Cloud db-changed → desktop pull (desktop-side)

| # | Task | Files |
|---|------|-------|
| 1.1 | Add `PendingTursoDbChangeNotification` type (`jobId?`, `dbId?`, `tables?`, `recordedAt`) | `src/gateway/types/cloudRuntime.ts` |
| 1.2 | Extend `DesktopHeartbeatResponse` with `pendingTursoDbChanges?: PendingTursoDbChangeNotification[]` | same |
| 1.3 | Add `reconcileFromCloudDbChanges(changes[])` — dedupe by syncKey, one session per DB | `src/gateway/services/tursoSyncSession.ts` |
| 1.4 | Add `handlePendingTursoDbChanges()` in CloudSyncService — call reconcile, clear handled IDs (when memory API supports ack) or idempotent reconcile | `CloudSyncService.ts` |
| 1.5 | Wire heartbeat: after `handlePendingCloudRuns`, call `handlePendingTursoDbChanges(body)` | `CloudSyncService.ts` |
| 1.6 | Export `syncTursoFromCloudDbChanged(scope)` for tests + internal use | `TursoSyncBridge.ts` |
| 1.7 | Resolve scope: prefer `dbId`, fallback `jobId`, expand job → `writeDbIds` **or legacy app primary registry** via `resolveJobTursoSyncKeysAsync` | `tursoSyncSession.ts`, `jobTursoSyncBookends.ts` |

**Memory server dependency (Phase 1B — separate repo / deploy):**

When cloud agent or cloud app host pushes Turso, memory server should:

1. Record `{ jobId?, dbId?, tables?, recordedAt }` in namespace-scoped pending queue (same store as `pendingCloudRuns`).
2. Return `pendingTursoDbChanges` on `POST /v1/cloud/runtime/heartbeat`.
3. Optionally ack/drain entries after desktop reports success (or TTL 24h).

Until memory server ships 1B, desktop code is **forward-compatible** (empty array = no-op).
E2E tests call `syncTursoFromCloudDbChanged` directly.

---

### Phase 2 — Demote post-cloud-run Turso pull

| # | Task | Files |
|---|------|-------|
| 2.1 | `handlePendingCloudRuns`: **git pull only** — remove `syncTursoAfterCloudRun` Turso call | `CloudSyncService.ts` |
| 2.2 | `CloudJobRunService.syncAfterCloudRun`: git pull + reload jobs; **remove** Turso pull (cloud already notified db-changed) | `CloudJobRunService.ts` |
| 2.3 | `cursorAgentStream` finally: git pull only; remove `syncTursoAfterCloudRun()` | `cursorAgentStream.ts` |
| 2.4 | Keep `syncTursoAfterCloudRun` exported but **deprecated** — delegates to db-changed reconcile for tests/migration | `TursoSyncBridge.ts` |
| 2.5 | Heartbeat wake safety: if `pendingTursoDbChanges` empty but `pendingCloudRuns` non-empty, run **remoteAhead-only** reconcile for affected jobIds + writeDbIds (no assumeRemoteChanged) | `CloudSyncService.ts` |

**Rationale:** Git still updates on cloud run (`jobs.json`, logs). Turso hydration moves to db-changed events; wake fallback uses cheap check only.

---

### Phase 3 — Remove redundant local→cloud push triggers

| # | Task | Files |
|---|------|-------|
| 3.1 | Remove `scheduleTursoPushForJob` from `/api/db/write` | `src/gateway/index.ts` |
| 3.2 | Remove `scheduleTursoPushForJob` from `/api/db/exec` | `src/gateway/index.ts` |
| 3.3 | Document: watcher + WAL `awaitWriteFinish` covers mini-app API writes | `SYNC_ARCHITECTURE_V2.md` §1.1 |
| 3.4 | **Keep:** job completion (5s), startup dirty, post_git dirty-only, pushNow, pre-cloud-run | — |

---

### Phase 4 — Overlap instrumentation (test hooks)

| # | Task | Files |
|---|------|-------|
| 4.1 | Push scheduler counters: `schedules`, `enqueues`, `pushJobCalls` per syncKey (test-only export) | `tursoPushScheduler.ts` |
| 4.2 | Pull session counters: `sessions`, `skipped`, `pulled`, `pushed` per trigger | `tursoSyncSession.ts` |
| 4.3 | `resetTursoSyncTestHooks()` for E2E isolation | both files |
| 4.4 | Dedupe guard: log warn if `enqueueTursoPush` called while same syncKey already in-flight + queued | `tursoPushScheduler.ts` |

---

### Phase 5 — Tests & test suite integration

#### 5.1 Unit tests (Vitest — `ci` tier)

| File | Cases |
|------|-------|
| `tests/turso-cloud-db-changed.test.ts` | reconcileFromCloudDbChanges dedupes; dbId scope; jobId → writeDbIds expansion |
| `tests/turso-sync-overlap.test.ts` | watcher-only path: simulate file change → single enqueue; api/db/write without schedule → still one enqueue via watcher mock |
| `tests/turso-push-scheduler-stats.test.ts` | debounce coalesces N schedules → 1 enqueue; completion priority shorter window |
| Extend `tests/turso-sync-session.test.ts` | db-changed trigger uses assumeRemoteChanged per change, not global |

#### 5.2 E2E script — `scripts/test-turso-sync-overlap-e2e.mjs`

**Tier:** `local` (prod memory + PAPR_API_KEY) — same env as `test:turso-sync-session-e2e`.

| # | Scenario | Pass criteria |
|---|----------|---------------|
| O1 | Single local write via better-sqlite3 | Exactly **1** pushJob after debounce flush (not 2) |
| O2 | Write via `/api/db/write` (gateway HTTP) | Exactly **1** pushJob — proves removed duplicate schedule |
| O3 | Cloud Turso write → `syncTursoFromCloudDbChanged({ dbId })` | Local registry row appears; **0** pushJob calls |
| O4 | Cloud write + db-changed reconcile + remoteAhead periodic | Second reconcile **skips** (remote unchanged) |
| O5 | Registry DB (`dbId` in data-sources) cloud change | Pull hydrates local `data/databases/{slug}/data.db` |
| O6 | Job with `writeDbIds: [dbId]` cloud change by jobId scope | Resolves to registry dbId and pulls |
| O7 | Local dirty + db-changed event | **Push session** first (1 pushJob), then pull — not 2 pulls |
| O8 | Rapid 10 writes in 2s | **1** enqueue after debounce (coalescing) |
| O9 | Sync-index bump → `syncTursoFromSyncIndex()` | Registry `dbId` hydrated via index hint (Mongo queue not required) |

Uses throwaway Turso DB + temp PAPR_HOME (same pattern as `test-turso-sync-session-e2e.mjs`).

#### 5.3 E2E script — extend `scripts/test-turso-sync-session-e2e.mjs`

Add step: after cloud write, call `syncTursoFromCloudDbChanged` instead of (or in addition to) `reconcileFromCloud` with assumeRemoteChanged — assert same outcome.

#### 5.4 Test suite manifest entries

Add to `scripts/lib/testSuiteManifest.mjs`:

```javascript
{
  id: "turso-sync-session-e2e",
  name: "Turso sync session E2E (scoped pull, skip, push-if-dirty)",
  tiers: ["local", "cloud", "full"],
  npmScript: "test:turso-sync-session-e2e",
  requires: ["auth"],
  optional: true,
},
{
  id: "turso-sync-overlap-e2e",
  name: "Turso sync overlap E2E (no double push, db-changed pull, registry)",
  tiers: ["local", "cloud", "full"],
  npmScript: "test:turso-sync-overlap-e2e",
  requires: ["auth"],
  optional: true,
},
```

Add `package.json` scripts:

```json
"test:turso-sync-overlap-e2e": "npm run build:gateway && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-turso-sync-overlap-e2e.mjs"
```

#### 5.5 Optional full-stack test (tier `full`)

When memory server ships `pendingTursoDbChanges`:

- `scripts/test-cloud-turso-db-changed-e2e.mjs` — cloud agent run → heartbeat → local row
- Requires: gateway + memory + cloudAgentGateway + auth

---

## 3. Overlap matrix (before → after)

| Event | Before (push paths) | After |
|-------|---------------------|-------|
| SQLite file change | watcher + /api/db/* schedule | **watcher only** |
| Job completion | watcher + bookends 5s | **bookends 5s** (faster debounce) |
| Git push success | post_git dirty enqueue | unchanged (dirty-only) |
| Upload now | pushNow dirty | unchanged |
| Pre-cloud-run | pushDirty | unchanged |

| Event | Before (pull paths) | After |
|-------|---------------------|-------|
| Cloud Turso write | post-job assumeRemoteChanged | **db-changed reconcile** |
| Heartbeat pendingCloudRuns | git + Turso assumeRemoteChanged | **git only** + pendingTursoDbChanges |
| App open | scoped remoteAhead | unchanged |
| Git pull | remoteAhead reconcile all | unchanged |
| Periodic 5min | git; Turso if git changed | unchanged |

---

## 4. Registry DB checklist

- [ ] `data-sources.json` entry with `dbId` discovered by `discoverTursoLinkedSources`
- [ ] Watcher watches `~/Papr/data/databases/{slug}/` (dirname of registry `data.db`)
- [ ] Push uses `linkedSourceSyncKey` → `dbId`
- [ ] Turso database name from `DatabaseRegistryService.tursoShortName`
- [ ] Cloud db-changed with `dbId` → scoped pull
- [ ] Job `writeDbIds` expanded on cloud-change scope resolution
- [ ] E2E O5 + O6 pass on prod memory

---

## 5. Rollout & feature flags

| Flag | Default | Purpose |
|------|---------|---------|
| `TURSO_PULL_AFTER_CLOUD_RUN` | `true` today → **`false`** after Phase 2 | Kill switch for legacy post-job Turso pull during migration |
| `TURSO_DB_CHANGED_PULL_ENABLED` | `true` | Disable desktop db-changed reconcile without removing code |
| `TURSO_PUSH_DEBOUNCE_MS` | `60000` | Unchanged — overlap tests use low value in E2E only |

Migration steps:

1. Ship Phase 1 + 4 + 5 (desktop forward-compatible, tests pass).
2. Ship memory server `pendingTursoDbChanges` (Phase 1B).
3. Ship Phase 2 + 3 (remove redundancies).
4. Set `TURSO_PULL_AFTER_CLOUD_RUN=false` in docs; remove deprecated path in follow-up release.

---

## 6. Implementation order (single PR or stacked)

```
PR1  Phase 1 + 4 + 5.1–5.3 + manifest     (db-changed handler, hooks, unit + session E2E)
PR2  Phase 5.2 overlap E2E                (prove no double push)
PR3  Phase 3                              (remove /api/db/* duplicate push)
PR4  Phase 2                              (demote post-cloud-run Turso)
PR5  Phase 1B                             (memory server — may be separate repo)
PR6  Phase 5.5 full-stack E2E             (after 1B)
```

**Verify each PR:**

```bash
nvm use 24
npm run test:sequential -- --tier=ci
npm run test:turso-sync-session-e2e      # prod memory + .env.local
npm run test:turso-sync-overlap-e2e      # after PR2
```

---

## 7. Success criteria

1. **No double push:** O1, O2, O8 pass — at most one `pushJob` per debounce window per syncKey.
2. **No missed registry pull:** O5, O6 pass — cloud change on registry `dbId` hydrates local SQLite.
3. **No overload:** Heartbeat with empty pending queues does zero Turso network calls (remoteAhead skip logged).
4. **Cloud path:** db-changed reconcile hydrates desktop without post-job `assumeRemoteChanged` pull.
5. **CI green:** All new unit tests in `ci` tier; E2E optional in `local`/`cloud` tier.

---

## 8. Open questions

1. **Memory server ack:** Drain `pendingTursoDbChanges` on desktop success, or rely on idempotent reconcile + TTL?
2. **Cursor agent stream:** Does cloud runtime return `writeDbIds` / affected `dbId`s in session metadata for immediate desktop reconcile without waiting for heartbeat?
3. **apps.papr.ai → desktop:** Long-term SSE bridge vs heartbeat queue only?

---

**Next step:** Implement PR1 (Phase 1 + 4 + unit tests + manifest entry), then PR2 overlap E2E.
