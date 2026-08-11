# Sync Architecture V2

> Companion to [`SYNC_CONTRACT.md`](./SYNC_CONTRACT.md) (the *what/who* — **Active**).
> This doc is the *how*: current-state audit with code references, target
> architecture, and phased plan. Ordering principle: **correctness before
> latency** — watchers are Phase 6, not Phase 1.

**Contract sections implemented here:**
- [§6 Fork/track PR contribute-back](./SYNC_CONTRACT.md#fork-track-and-contribute-back-pr-model) → [§2.4](#24-contribute-back-pr-architecture)
- [§7.1 Max-wait under load](./SYNC_CONTRACT.md#max-wait-under-heavy-load) → [§2.5](#25-max-wait-and-backpressure)
- [§12.1 Cross-layer drift](./SYNC_CONTRACT.md#cross-layer-drift-git--turso--publish) → [§2.6](#26-cross-layer-flush-ordering)

---

## 1. Current state (audited, with code references)

### 1.1 Four independent pipelines

| Layer | Trigger(s) | Debounce | Code |
|---|---|---|---|
| **Git** | chokidar on `workspace/`+`data/` only; startup `enqueueSubDirs()` scan for `apps/`+`Jobs/`; Composer prepare (`pushNow`, 120s cooldown); manual | 15s watcher; queue serial | `CloudSyncService.ts:38` (`QUEUED_DIRS`), `:891` (`enqueueSubDirs`), `:328` (`prepareForComposerRun`), `cursorAgentStream.ts:90` |
| **Turso** | `TursoLinkedDbWatcher` (linked DB dirs, depth 0); job completion (5s); post-git-push schedule; startup dirty push; mini-app `/api/db/write` + `/api/db/exec` (watcher only — no duplicate schedule in gateway) | 60s default (`TURSO_PUSH_DEBOUNCE_MS`), 5s completion | `tursoPushScheduler.ts:20–24,39–54`, `TursoLinkedDbWatcher.ts:125`, `jobTursoSyncBookends.ts:75`, `CloudSyncService.ts:1434`, `gateway/index.ts` (`/api/db/write`, `/api/db/exec`) |
| **Publish catalog** | Auto-republish after git push | — | `tryAutoPublishCloudLinks` post-push hook |
| **Edge cache** | Revision marker + host invalidation after push; browser F5 | — | `cloudAppRevisionMarker.ts` |
| **Pull** | Every 5 min; heartbeat 60s; after git pull → Turso pull | — | `CloudSyncService.ts:43–44,1074,1120,1581` |

**Cross-layer gap:** `pushAppNow` runs git then Turso **in parallel failure reporting**, not schema-first ordering:

```631:665:src/gateway/services/CloudSyncService.ts
  async pushAppNow(appId: string): Promise<void> {
    // ... pushGitNow first, then pushAppLinkedSources — independent try/catch
  }
```

Publish can follow git before Turso verify completes (`tryAutoPublishSyncedApps` post-push hook).

### 1.2 Watcher inventory (there are already FIVE chokidar trees)

| Watcher | Watches | Ignores of note | Code |
|---|---|---|---|
| CloudSync | `workspace/`, `data/` | `**/*.db*` | `CloudSyncService.ts:1736` |
| AppService | one watcher **per app dir** | `dist/`, `.versions/`, **`data-sources.json`, `linked-databases.json`** | `AppService.ts:2252`, `appWatchIgnore.ts:10–13` |
| CodeFileWatcher | `apps/**`+`Jobs/**` code, `job.json`, **`data-sources.json`** | `data/`, `dist/`, venvs | `storage/CodeFileWatcher.ts:57` |
| TursoLinkedDbWatcher | linked `data/` dirs (job **and** registry) | depth 0, WAL-aware | `TursoLinkedDbWatcher.ts:125` |
| Cloud agent | sandbox `data/` during cloud runs | — | `cloudAgentTursoDebouncedPush.ts:148` |

**Implication:** the "EMFILE risk" argument against watching `apps/` is moot — it's
already watched per-app. The gap is that **no watcher feeds the git queue** for
`apps/`/`Jobs/`; only the startup scan does.

**Fork/track:** Contributor app folders are watched and git-synced to **contributor's** namespace repo like any app. No gate on Propose/PR. Track upstream: manual **Updates** button (`CloudUpstreamBar`) + **auto pull-on-publish** (`pullTrackAppsOnPublish` polls `__papr__/app-revision.json` on desktop heartbeat and after publish).

### 1.3 Known drift classes (all can show green)

| # | Class | Root cause | Ref |
|---|---|---|---|
| D1 | Code/data version skew | Git + Turso have no joint version; bundle lands before rows/schema | `CloudAppPublishService.ts`, host serves latest git bundle |
| D2 | Silent local-wins (rows) | Pre-push pull skipped when local dirty | `TursoSyncBridge.ts:430` |
| D3 | Full-pull overwrite | Delta gap → silent full pull, no per-row merge | `tursoSyncBridgeCore.ts:1250` |
| D4 | Delete resurrection | Full-copy paths carry no tombstones | same |
| D5 | Legacy tables: last-pull-wins | Tables without `_papr_row_version` | `rowSyncColumns.ts` |
| D6 | Dead-letter black hole | `isDeadLetter` folders skipped forever, no UI | `CloudSyncService.ts:905` |
| D7 | Hash-state lies | mtime+size fingerprint | `cloudSync/syncState.ts` |
| D8 | Git local-wins (multi-Mac) | `merge --no-edit -X ours origin/main` | `CloudSyncService.ts:1702` |
| D9 | Sliding-debounce starvation | Long job → WAL churn resets 60s debounce forever | `tursoPushScheduler.ts:234–254` (no max-wait) |
| D10 | Invisible non-sync | `scratch`/unlinked sources excluded silently | `tursoLinkedSources.ts` |
| D11 | Stale link watcher | `data-sources.json` writes don't refresh Turso watcher | `TursoLinkedDbWatcher.ts:146` |
| D12 | Blended status | One `overall` merges 4 layers; UI polls 25s | `ui/utils/appCloudSyncStatus.ts:358` |
| D13 | ~~Contribute-back metadata-only~~ **Fixed (Phase 3b)** | PR pushes app + Jobs + `jobs.json`/`databases.json` slices; owner approve merges on GitHub + `pullNow()` | `CloudAppContributeService.ts`, `contributeDataIndexMerge.ts`, `cloudInstall.ts`, panels |
| D14 | Git-before-Turso publish | Independent layers; publish after git | `pushAppNow`, `tryAutoPublishSyncedApps` |
| D15 | Schema/row split within Turso | Ledger says migrated; tables missing or empty shells | `tursoSyncStatus.ts:99`, `jobMigrationTursoSync.ts` |

### 1.4 Contribute-back (Phase 3b — implemented)

| Step | Code | What happens |
|------|------|----------------|
| Propose | `submit_cloud_app_change` → `CloudAppContributeService.propose()` | Stages `apps/{forkId}/`, linked `Jobs/`, migration SQL; merges contributor `jobs.json` + `databases.json` slices into owner clone; pushes `contrib/{lineageId}/{shortId}`; opens PR |
| Owner UI | `CloudChangeRequestsPanel.tsx` | Lists incoming PRs with `prUrl`, title, description |
| Approve | `gateway/index.ts` → memory `POST .../changes/{id}/approve` | GitHub App merges PR; gateway runs owner `pullNow()` + Turso flush |
| Reject | same route with reject | Closes PR without merge |

**Removed:** `CloudAppChangeMergeService` local-folder copy (`mergeForkIntoSource`) — owner never reads contributor's `installedAppId` folder.

**Track mode upstream** (separate): `CloudAppTrackSyncService.syncTrackApp` clones owner repo sparse-checkout, 3-way hash merge with `syncSnapshot` — works for pull, not contribute-back.

### 1.5 Structural diagnosis

The primitives are right (CDC changelog, row versions, fingerprints, migration
ledger, compaction). The problems are:

1. **Two replication mechanisms** — oplog + bulk copy with heuristic fallbacks (`skipPullWhenLocalDiffers`, delta→full fallback).
2. **No convergence verification** — "synced" is a push receipt, never a content check.
3. **Independent layer pushes** — git, Turso, publish not ordered (D14).
4. ~~**Contribute-back not a transport**~~ — **Fixed Phase 3b:** PR carries code; legacy metadata-only route removed (404).

---

## 2. Target architecture

```
                         ┌────────────────────────────────────────┐
                         │           SyncCoordinator              │
                         │  markGitDirty / markDbDirty            │
                         │  flushNow(appId) / getStatus(appId)    │
                         │  maxWaitTimers / backpressure          │
                         └──────────┬─────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
   ┌─────────────┐          ┌──────────────┐          ┌─────────────────┐
   │  GitQueue   │          │ TursoQueue   │          │ ContributePR    │
   │  serial     │          │ serial/src   │          │ (fork propose)  │
   └──────┬──────┘          └──────┬───────┘          └────────┬────────┘
          │                        │                           │
          ▼                        ▼                           ▼
   prepare → commit →      migrate remote →           branch push → open PR
   push → verify SHA       oplog push (chunked) →      (owner repo)
          │                verify tables                     │
          └────────────────┬─────────────────────────────────┘
                           ▼
              publish (if web-ready gate passes)
                           ▼
              cache revision notify
```

Rules (from contract):

1. **Oplog is the only routine row path.** Full copy = explicit bootstrap only. Delta gap → fail loudly. (D3, D4)
2. **Writer authority — bidirectional default.** Absent field = web can write. Sync work focuses on **pull-before-push + LWW** so web edits survive desktop sync — **not** on making web read-only. Optional `desktop` mode (web 403) is explicit opt-in only, deferred. (D2)
3. **Dirty-marking through coordinator API.** (D11)
4. **Max-wait + backpressure** on all debounces. (D9, §2.5)
5. **Synced is earned** — post-push verify + convergence hash. (D7)
6. **Per-layer status** — dead-letter, scratch, PR open, not web-ready. (D6, D10, D12, D13)
7. **Joint web-ready gate** — host serves prior bundle until Turso schema version OK. (D1, D14, D15)
8. **Contribute-back = PR** on owner's repo, not metadata ticket. (D13)

### Triggers after refactor

| When | Git | Turso | Publish | Pull / PR |
|---|---|---|---|---|
| App/job code change | auto 45s (max 5m) → coordinator | — | — | — |
| `data-sources.json` change | auto | refresh linked watcher | — | — |
| DB row write | — | auto 30s (max 120s) | — | — |
| Upload now / agent flush | step 4 after Turso verify | steps 1–3, 5 | step 6 if web-ready | — |
| Contributor Propose | — | — | — | branch + PR on owner repo |
| Owner merge PR | pull → full Upload now pipeline | same pipeline | after gate | close PR |
| Track Updates pull | — | linked job sync optional | — | `CloudAppTrackSyncService` |
| 5 min / heartbeat | — | — | — | pull + convergence check |

**Removed after validation:** Composer prepare push, post-git Turso schedule,
job-completion Turso schedule, startup hash scan as primary mechanism,
~~`mergeForkIntoSource` local-folder copy~~ (removed Phase 3b).

---

### 2.4 Contribute-back PR architecture

**Contract:** [`SYNC_CONTRACT.md` §6](./SYNC_CONTRACT.md#fork-track-and-contribute-back-pr-model)

#### Flow (implemented Phase 3b)

```
Contributor desktop                    Memory server / GitHub              Owner desktop
─────────────────                    ───────────────────────              ─────────────
edit apps/{forkId}/
       │
Propose click / submit_cloud_app_change
       │
       ├─ prepareAppsForCloud (dist, bundle.json)
       ├─ git: branch contrib/{lineageId}/{shortId}
       │         commit apps/{forkId}/ + Jobs/
       ├─ push to OWNER papr-work (scoped token)
       └─ POST .../changes  +  open PR ──────────►  PR visible ─────────►  review diff
                                                      (GitHub or            merge PR
                                                       in-app panel)              │
                                                                                 ▼
                                                                          git pull
                                                                          SyncCoordinator.flushNow(sourceAppId)
                                                                          (§2.6 ordering)
```

#### Implemented components (Phase 3b)

| Component | Responsibility |
|-----------|----------------|
| **`CloudAppContributeService`** | Propose: diff fork, stage app + Jobs + data index slices, push branch, submit PR metadata |
| **`contributeDataIndexMerge.ts`** | Merge contributor `jobs.json` / `databases.json` entries into owner repo (portable paths) |
| **`CloudAppChangeRequestService`** | Fetch incoming change records from memory |
| **Memory server** | `prepare` / `submit` / `incoming` / `approve` / `reject`; GitHub App merge on approve |
| **`CloudChangeRequestsPanel`** | Owner: PR link, approve/reject |
| **`CloudContributeBackPanel` / `CloudUpstreamBar`** | Contributor: propose UI |
| **`submit_cloud_app_change` tools** | Agent orchestration; returns `prUrl`, `stagedPaths` |
| **`ephemeralGitEnv`** | Git subprocesses: no macOS Keychain store for short-lived `x-access-token` URLs |

**Deleted:** `CloudAppChangeMergeService.ts` (local merge).

#### Scoped git token (memory server)

- Issue token: push to `contrib/*` branches on owner's `papr-work` repo only.
- Paths allowed: `apps/{forkId}/**`, dependent `Jobs/{id}/**`, migration SQL under `data/databases/`.
- Deny: force-push `main`, delete branches, access other namespaces' paths.
- Alternative: GitHub fork + cross-repo PR (no direct push to owner repo).

#### File map (Phase 3b)

| File | Role |
|------|------|
| `src/gateway/services/CloudAppContributeService.ts` | Branch push + memory submit |
| `src/gateway/services/cloudSync/contributeDataIndexMerge.ts` | Jobs/databases registry merge |
| `src/gateway/services/CloudAppChangeRequestService.ts` | Incoming list fetch |
| `src/core/tools/cloudInstall.ts` | Agent install + contribute tools |
| `src/gateway/index.ts` | Propose + approve routes (approve → memory merge + pull) |
| `src/gateway/utils/ephemeralGitEnv.ts` | Disable git credential helper for cloud clones |
| `ui/components/Apps/CloudChangeRequestsPanel.tsx` | Owner incoming PRs |
| `ui/components/Apps/CloudContributeBackPanel.tsx` | Contributor propose |
| Memory: `cloud_app_contribute_service.py` | GitHub App PR merge on approve |
| `scripts/test-contribute-back-e2e.mjs` | Local E2E (gateway flow + optional `--approve`) |
| `tests/contribute-data-index-merge.test.ts` | Unit tests for index merge |

#### Contributor sync during open PR

- **No hold** on contributor git/Turso watchers (`SYNC_CONTRACT.md` §6).
- Contributor fork syncs to contributor namespace; owner repo unchanged until PR merge.

---

### 2.5 Max-wait and backpressure

**Contract:** [`SYNC_CONTRACT.md` §7.1](./SYNC_CONTRACT.md#max-wait-under-heavy-load)

#### Today

| Mechanism | Code | Gap |
|-----------|------|-----|
| Turso debounce | `tursoPushScheduler.ts:234–254` — `setTimeout` reset on every write | No max-wait; starvation (D9) |
| Turso serial queue | `processTursoPushQueue` — one job at a time, 1.5s interval | ✅ |
| Rate limit backoff | `rateLimitUntilMs`, exponential 30s→120s | ✅ |
| Git serial queue | `CloudSyncService` queue lock | ✅ |
| Progress UI | — | Missing |
| Oplog chunking | Full table push paths still exist | Needs bounded batches |

#### Target (`SyncCoordinator`)

```typescript
// Pseudocode — implement in src/gateway/services/cloudSync/SyncCoordinator.ts

interface FlushState {
  layer: "git" | "turso";
  appId?: string;
  startedAt: number;
  progress?: { current: number; total: number; label: string };
}

class SyncCoordinator {
  private maxWaitTimers = new Map<string, NodeJS.Timeout>();
  private firstDirtyAt = new Map<string, number>();
  private activeFlush: FlushState | null = null;

  markDbDirty(syncKey: string): void {
    if (!this.firstDirtyAt.has(syncKey)) {
      this.firstDirtyAt.set(syncKey, Date.now());
    }
    this.resetDebounce(syncKey, "turso");
    this.armMaxWait(syncKey, "turso", 120_000);
  }

  private armMaxWait(key: string, layer: string, maxMs: number): void {
    const first = this.firstDirtyAt.get(key) ?? Date.now();
    const elapsed = Date.now() - first;
    const remaining = Math.max(0, maxMs - elapsed);
    // Schedule flush at remaining; do NOT reset firstDirtyAt on new writes
  }

  async flushNow(appId: string): Promise<FlushResult> {
    // §2.6 ordering — await each step; expose progress to /api/sync/items
  }
}
```

#### Turso push chunking (inside existing bridge)

| Change | Location |
|--------|----------|
| Batch oplog entries (max N rows or max bytes per round-trip) | `tursoSyncBridgeCore.ts` delta push |
| Report `{ table, batch, totalBatches }` to status API | `tursoSyncStatus.ts` |
| Skip loading full table into memory for fingerprint | Already table-scoped; enforce for bootstrap |

#### Status API extension

```typescript
// /api/sync/items response (target)
{
  layers: {
    git: { status: "synced" | "pending" | "uploading" | "error", ... },
    turso: [{
      alias: "joe",
      status: "syncing",
      progress: { tablesDone: 3, tablesTotal: 19, queueDepth: 2 },
      schemaDrift: false
    }],
    publish: { status: "not_web_ready", reason: "turso_pending" }
  }
}
```

---

### 2.6 Cross-layer flush ordering

**Contract:** [`SYNC_CONTRACT.md` §12.1](./SYNC_CONTRACT.md#cross-layer-drift-git--turso--publish)

#### Target `flushNow(appId)` sequence

Implement in `SyncCoordinator` (or refactor `CloudSyncService.pushAppNow`):

| Step | Action | Code to extend |
|------|--------|----------------|
| 1 | Apply local SQLite migrations for all linked sources | `jobMigrationTursoSync.ts`, job pre-run hooks |
| 2 | Turso: replay remote migrations (`alignMigrationLedgers`, `migrationSatisfiedOnRemote`) | `jobMigrationTursoSync.ts:213`, `jobMigrationLedgerSync.ts:241` |
| 3 | Turso: oplog delta push (chunked) | `TursoSyncBridge.pushAppLinkedSources`, `tursoSyncBridgeCore.ts` |
| 4 | Verify Turso: table set, ledger, spot counts | ✅ `cloudSync/postPushVerify.ts` → `verifyTursoConvergenceForApp()` |
| 5 | Git: `prepareAppsForCloudGitSync` → commit → push | `prepareAppsForCloud.ts`, `CloudSyncService.pushGitNow` |
| 6 | Verify git remote SHA | ✅ `verifyGitRemoteSha()` — runs after `pushAppNow` |
| 7 | Publish if `webReady(appId)` | ✅ `isAppVerifiedReadyForCloudLink()` gates `tryAutoPublishSyncedApps` |
| 8 | Cache revision notify | `notifyCloudAppRevision.ts` |

#### Web-ready gate

```typescript
async function webReady(appId: string): Promise<{ ready: boolean; reason?: string }> {
  const turso = await buildTursoSyncItemsReport(...);
  for (const source of turso.items for appId) {
    if (source.schemaDrift) return { ready: false, reason: "schema_drift" };
    if (source.status !== "synced" && source.status !== "verified") {
      return { ready: false, reason: "turso_pending" };
    }
    if (!(await migrationSatisfiedOnRemote(...))) {
      return { ready: false, reason: "migration_unsatisfied" };
    }
  }
  return { ready: true };
}
```

#### Cloud App Host gate (Phase 4)

| File | Change |
|------|--------|
| `publishedAppRevision.ts` | Embed `requiredSchemaVersion` in bundle meta |
| Cloud App Host | Compare remote Turso schema version via memory API; serve previous bundle if behind |
| `ui/utils/appCloudSyncStatus.ts` | Surface `not_web_ready` on publish layer |

#### Drift detection today (partial)

| Signal | Code |
|--------|------|
| `schemaDrift` flag | `tursoSyncStatus.ts:288–299` (`detectRemoteSchemaDrift`) |
| `localTableCount > remoteTableCount` → pending | `tursoSyncStatus.ts:105–106` |
| Schema drift tables force push | `tursoSyncBridgeCore.ts:983–989` |
| Independent git/Turso on push | `CloudSyncService.ts:631–665` |

---

### 2.7 Efficient dirty detection

**Contract:** [`SYNC_CONTRACT.md` §7.2](./SYNC_CONTRACT.md#efficient-dirty-detection-two-tier)

#### Today vs target

| Concern | Today | Target |
|---------|-------|--------|
| Git dirty | Content hash in `.cloud-sync-state.json` | Same ✅ — `hasItemChanged()` |
| Turso dirty | **Full table fingerprints** on debounce (`isJobDbDirty`) | **Oplog cursor first** — `MAX(_papr_sync_log.id) > lastPushedLogId` |
| Watcher → mark | Debounce schedules push directly | **`markDbDirty(syncKey)`** + cheap skip in coordinator |
| Pull cheap check | Always attempts delta pull path | Skip if `remoteMaxLogId <= lastPulledLogId` |
| Heavy verify | On status API sometimes | Upload now + 5-min convergence only |

#### Implementation sketch (Phase 5)

```typescript
// tursoSyncState.ts — add fast path
function isLinkedSourceDirtyFast(state: TursoSyncStateEntry, db: Database): boolean {
  if (state.dirtyFlag) return true;
  const localMax = db.prepare("SELECT MAX(id) AS m FROM _papr_sync_log").get()?.m ?? 0;
  return localMax > (state.lastPushedLogId ?? 0);
}

// Only if fast path true OR verify requested:
async function confirmDirtyWithFingerprints(...) { ... existing isJobDbDirty ... }
```

| File | Change |
|------|--------|
| `tursoSyncState.ts` | `dirtyFlag`, `markDbDirty`, `clearDirtyAfterPush` |
| `tursoSyncLog.ts` | Watcher callback → `markDbDirty` |
| `tursoPushScheduler.ts` | Skip push if `!isLinkedSourceDirtyFast` |
| `TursoSyncBridge.ts` | Fingerprints on verify / Upload now only |
| `CloudSyncService.ts` | Git hash skip unchanged; respect manual mode (§2.8) |

---

### 2.8 Sync mode settings ✅ (2026-08-10)

**Contract:** [`SYNC_CONTRACT.md` §2](./SYNC_CONTRACT.md#2-cloud-sync-off-vs-on)

Implemented in `cloudUploadMode.ts`, `CloudSyncTab.tsx`, publish prefs + publish bar UI, and `tursoPushScheduler.ts` manual guards.

#### New preference fields

| Location | Field | Type |
|----------|-------|------|
| `AppSettings.preferences` | `cloudAutoUploadEnabled` | `boolean` (default `true`) |
| Per-app publish prefs | `cloudEnabled` | `'inherit' \| true \| false` |
| Per-app publish prefs | `uploadMode` | `'inherit' \| 'auto' \| 'manual'` |

#### Gateway behavior (Phase 3)

| Check | Where |
|-------|-------|
| Global cloud off | Existing — `CloudSyncService` early return |
| Per-app `cloudEnabled: false` | Skip git queue, Turso push, publish for that `appId` |
| `uploadMode: manual` or global auto-upload off | Mark dirty, show `pending (manual)`; **do not** enqueue auto push |
| Upload now / `pushAppNow` | **Always** runs full §2.6 pipeline (ignore manual for explicit user action) |

#### Files to touch

| File | Change |
|------|--------|
| `src/core/types/storage.ts` | Add `cloudAutoUploadEnabled` |
| `SettingsStorage.ts` | Default + getters |
| `ui/components/Settings/CloudSyncTab.tsx` | Global auto-upload toggle |
| Publish prefs schema / `CloudAppPublishService` | Per-app `cloudEnabled`, `uploadMode` |
| Publish bar UI | Per-app dropdown: Auto / Manual / Local only |
| `CloudSyncService.ts` | `shouldAutoPushApp(appId)` guard before queue |
| `tursoPushScheduler.ts` | Respect manual per linked app |
| `tursoSyncStatus.ts` | `pending (manual)` detail string |
| `SystemPrompt.ts` | Agent rules §13 #10–11 |

#### Turso coupling (v1)

**Do not split** git vs Turso auto-push per app — manual mode pauses both. Upload now runs §2.6 ordering. Document advanced split as future only.

#### Tests (Phase 3)

| Test | Assert |
|------|--------|
| Manual app edit | Status `pending (manual)`, no remote push after debounce |
| Upload now on manual app | Git + Turso + publish run |
| `cloudEnabled: false` | No sync items for app |
| Global auto-upload off | All inherit apps manual unless per-app `auto` |

---

## 3. Phased plan

| Phase | Work | Fixes | Risk |
|---|---|---|---|
| **0. Measure** | Trigger logging; convergence diagnostic on all linked sources; document Joe Coffee drift class | evidence | none |
| **1. Correctness P0** | Kill silent full-pull fallback; tombstones; backfill `_papr_row_version`; **Turso max-wait 120s** in scheduler | D3, D4, D5, D9 | migration care |
| **2. Bidirectional sync** | Pull-before-push always; LWW merge + conflict surfacing for default `bidirectional`; **preserve web write** — do not add read-only gates by default | D2 | behavior change on Turso pull |
| **2b. Desktop opt-in (defer)** | `writeAuthority: desktop` → web 403 only when field explicitly set | — | optional, not default |
| **3. Status + PR + settings** | Per-layer status + progress; **Contribute-back PR flow ✅ (3b)**; **sync mode settings ✅**; **post-push verify ✅** (SHA + table counts); dead-letter on publish bar | D6, D10, D12, D13, D7 partial | memory deploy + E2E verify |
| **4. Cross-layer + convergence** | **`pushAppNow` → ordered flush ✅**; web-ready gate ✅; 5-min hash check ✅; host schema banner + revision meta ✅ | D1, D14, D15 | host change |
| **5. Coordinator + watchers + dirty tier** | **`SyncCoordinator` ✅**; oplog cursor before fingerprints ✅; watchers → `markGitDirty`/`markDbDirty` ✅; skip redundant post-git Turso when flushed ✅; progress API partial | D9, D11, latency | parallel-run 2 weeks |
| **6. E2E + cleanup** | `test-sync-full-stack-e2e.mjs`; PR contribute E2E; schema-ahead scenario test; remove redundant triggers | regressions | — |
| **7. Optional** | Server-side builds (drop `dist/` from git); multi-Mac conflict copies | D8 | larger |

### Acceptance criteria

1. Edit app TSX (auto-upload app) → cloud code updated ≤2 min, no manual push.
2. Insert row in registry DB → Turso matches ≤45s (verified by content hash, not receipt).
3. **Bidirectional web write preserved** — forms and `/api/db/write` work on all default apps after sync changes.
4. Kill Turso mid-push → *Turso: error* / *syncing* while *Git: synced*; dirty retained.
5. Delete a row locally → does not resurrect after any pull path.
6. Long-running job (10 min writes) → first Turso push within 120s (max-wait).
7. **Contributor Propose → owner sees PR with code diff → merge → owner web app updated with schema+rows verified.**
8. **Git push with new migration SQL but Turso behind → publish bar `not web-ready`; web serves previous bundle.**
9. **Max-wait with 19 tables dirty → status shows `syncing 3/19`; no OOM; no false green.**
10. Web user submits form on published app → row appears in Turso within sync window (bidirectional path).
11. **Manual upload app** — edit locally → no auto push for 2 min → Upload now → cloud updated.
12. **Per-app local only** — `cloudEnabled: false` → no git/Turso/publish side effects.
13. **Dirty fast path** — 19-table app, no writes → debounce tick completes without fingerprint scan (<50ms local check).

---

## 4. Existing tests vs gaps

| Test | Covers | Missing |
|---|---|---|
| `test:cloud-sync` | git push | Turso, web, ordering |
| `test:turso-delta-sync` | oplog push/pull | git, web, registry path |
| `test:turso-sync-status` | schemaDrift pending | web-ready gate |
| `test:cloud-app-host` | host serves bundle | schema version gate |
| `turso-linked-db-watcher.test.ts` | job dirs | registry `data/databases/{slug}/` |
| `turso-push-scheduler.test.ts` | queue serial | max-wait timer |
| **(new)** full-stack E2E | desktop→GitHub→Turso→web | — (Phase 6) |
| **(new)** contribute-back PR E2E | propose→PR→merge→flush | `npm run test:contribute-back-e2e` — **script ready; full green pending local Keychain + app-in-git** |
| **(new)** git-ahead-of-turso | migration in git, Turso empty | banner + revision pin (`cloudAppSchemaGate.ts`); full bundle rollback deferred |
| **(new)** max-wait backlog | 19-table push, progress status | — (Phase 5) |
| **(new)** bidirectional web write E2E | web form submit → Turso row | regression guard |
| **(new)** manual upload mode | no auto push; Upload now works | — (Phase 3) |
| **(new)** per-app cloudEnabled | local-only app excluded from sync | — (Phase 3) |
| **(new)** oplog dirty fast path | no fingerprint when log unchanged | — (Phase 5) |
| **(new)** authority opt-in (defer) | web 403 only when `writeAuthority: desktop` set | — |
| **(new)** convergence checker unit | hash equality/drift | `tests/convergence-hash.test.ts`, `tests/web-ready.test.ts`, `tests/flush-app-now.test.ts` |

---

## 5. File index (quick reference)

| Concern | Primary files |
|---------|---------------|
| Git sync | `CloudSyncService.ts`, `cloudSync/prepareAppsForCloud.ts` |
| Turso push | `TursoSyncBridge.ts`, `tursoSyncBridgeCore.ts`, `tursoPushScheduler.ts` |
| Migrations | `jobMigrationTursoSync.ts`, `jobMigrationLedgerSync.ts`, `tursoSchemaMigration.ts` |
| Status | `tursoSyncStatus.ts`, `cloudSync/syncItemStatus.ts`, `ui/utils/appCloudSyncStatus.ts` |
| Publish | `CloudAppPublishService.ts`, `cloudPublishDrift.ts` |
| Fork install | `CloudAppInstallService.ts`, `CloudAppLineageService.ts` |
| Track pull | `CloudAppTrackSyncService.ts`, `cloudSync/trackUpstreamRevision.ts` |
| Post-push verify | `cloudSync/postPushVerify.ts` |
| Contribute (implemented) | `CloudAppContributeService.ts`, `contributeDataIndexMerge.ts`, `CloudAppChangeRequestService.ts`, `cloudInstall.ts`, panels |
| Contribute tests | `scripts/test-contribute-back-e2e.mjs`, `tests/contribute-data-index-merge.test.ts` |
| Sync mode settings | `storage.ts`, `CloudSyncTab.tsx`, publish prefs, `CloudSyncService.ts`, `tursoPushScheduler.ts` |
