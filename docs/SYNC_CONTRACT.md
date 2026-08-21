# Paprwork Sync Contract

> **Canonical spec** for what sync guarantees, what it may drop, and who may write
> each resource. **V3 target architecture:** [`SYNC_ARCHITECTURE_V3.md`](./SYNC_ARCHITECTURE_V3.md).
> **V3 implementation plan:** [`SYNC_V3_IMPLEMENTATION_PLAN.md`](./SYNC_V3_IMPLEMENTATION_PLAN.md).
> Historical V2 implementation details: [`SYNC_ARCHITECTURE_V2.md`](./SYNC_ARCHITECTURE_V2.md).
> Publish/cache pipeline details: [`CLOUD_SYNC_READY_PIPELINE.md`](./CLOUD_SYNC_READY_PIPELINE.md).

**Status:** Active (2026-08-18). Decisions below are binding for new sync work.

---

## 1. Principles

1. **Local-first always.** Paprwork works fully with cloud sync disabled. Cloud is an optional replication layer, not a runtime dependency.
2. **Desktop is the primary publisher** when cloud sync is on — but other writers (web, cloud agent, other devices) must be handled explicitly, not silently overwritten.
3. **Four layers, four statuses.** Git (code), Turso (rows), publish catalog, edge cache each have their own dirty/synced/error state. One blended “synced” chip is not sufficient.
4. **Routine row sync is log-only (Sync V3).** Desktop ships local `_papr_sync_log` entries via **workspace log**; memory applies to Turso. Bulk table copy (bootstrap, snapshot fallback, full pull) is allowed only for explicit bootstrap/repair — never as a silent heuristic fallback. (Legacy: direct fingerprint Turso CDC **deleted** from desktop hot path as of 2026-08-18.)
5. **“Synced” must be earned.** A successful push is a receipt; content convergence (counts + row hashes) is verified separately.
6. **Web write is default.** Published apps are **bidirectional** — web users can submit forms and mutate data via `/api/db/write`. Sync correctness work must **not** regress this. Read-only web is an explicit rare opt-in only.

---

## 2. Cloud sync OFF vs ON

### Cloud sync OFF (`preferences.cloudSyncEnabled === false`)

| Capability | Behavior |
|------------|----------|
| Apps, jobs, SQLite | Fully local — no change |
| Turso bridge | Not started |
| Git remote push | Not started |
| Publish to apps.papr.ai | Blocked (`checkCloudPublishAvailable`) — use `export_app_bundle` |
| Agent / user expectation | No “Upload now”, no cloud DB, no web hosting |

**Contract:** Zero cloud sync code paths run. Users are not penalized with errors or partial states.

### Cloud sync ON

Desktop gateway replicates **code → GitHub**, **rows → Turso**, and triggers **publish + cache invalidation**. Web apps on `apps.papr.ai` stay live with desktop closed (see [Always-on requirement](./CLOUD_SYNC_READY_PIPELINE.md#always-on-requirement-no-desktop)).

### Global settings (namespace-wide)

Stored in `preferences` (Settings → Cloud Sync). Existing fields plus target additions:

| Setting | Default | Effect |
|---------|---------|--------|
| `cloudSyncEnabled` | `true` | Master switch — when `false`, entire namespace is local-only (§2 OFF) |
| `cloudAutoPublishEnabled` | `true` | After a successful upload, auto-republish to apps.papr.ai catalog |
| **`cloudAutoUploadEnabled`** (target) | `true` | When `false`, **no automatic git/Turso push** for any app — only **Upload now**, publish bar sync, or agent `push_cloud_sync` |

**Today (2026-08-10):** `cloudSyncEnabled`, `cloudAutoPublishEnabled`, and **`cloudAutoUploadEnabled`** exist in `AppSettings.preferences`. Per-app **`uploadMode`** and **`cloudEnabled`** live in publish prefs (`cloudUploadMode.ts`, publish bar UI). Manual mode pauses auto git/Turso push; **Upload now** runs the full pipeline.

### Per-app settings (target — Phase 3)

Each mini-app may override global defaults. Stored in publish prefs / app metadata (e.g. `cloud-publish-prefs.json` or `apps/{id}/metadata.json`):

| Field | Values | Effect |
|-------|--------|--------|
| **`cloudEnabled`** | `true` \| `false` \| `inherit` | `false` = this app is **local sandbox** — no git queue, no Turso push, no publish, even if global cloud is on |
| **`uploadMode`** | `auto` \| `manual` \| `inherit` | Controls **when** cloud upload runs (see below) |

**UI:** Publish bar + Settings → Cloud Sync → per-app row. App list shows `Local only`, `Manual upload`, or `Auto sync`.

### Upload mode: auto vs manual

Users who want to **test locally before others see changes** set `uploadMode: manual` (per app or globally via `cloudAutoUploadEnabled: false`).

| Mode | Watchers | Dirty tracking | Auto push (git + Turso) | Upload now / agent |
|------|----------|----------------|-------------------------|-------------------|
| **Auto** (default) | ✅ Run | ✅ Mark dirty | ✅ Debounce + max-wait (§7) | ✅ Also works (guaranteed flush) |
| **Manual** | ✅ Run | ✅ Mark dirty, status **`pending (manual)`** | ❌ **No auto push** | ✅ Only path to cloud |

**Manual does not disable local development** — jobs, bash, preview, and SQLite all work normally. Cloud layers simply stay stale until explicit upload.

**Agent behavior:** If app is `manual` or global auto-upload off, **do not** call `push_cloud_sync` unless the user explicitly asks. Tell them local changes are ready and they can click **Upload now** when satisfied.

### Should Turso be separate from git manual mode?

**Recommendation: no — keep coupled per app (v1).**

| If split… | Problem |
|-----------|---------|
| Git manual, Turso auto | Published web shows **new rows, old UI** — confusing and hard to debug |
| Git auto, Turso manual | Web shows **new UI, missing/stale data** — Joe Coffee class bugs |
| **Both manual together** | Local sandbox until Upload now — **one clear user mental model** ✅ |

**Contract (v1):** `uploadMode: manual` pauses **both** git push and Turso push for that app’s linked sources. **Upload now** runs the full §12.1 pipeline (migrate → Turso schema → Turso rows → git → verify → publish).

**Future (optional):** Advanced settings could split `gitUploadMode` / `tursoUploadMode` for power users — defer until someone needs it.

### Pull in manual mode

Periodic **pull** (git fetch, Turso delta) may still run so the desktop stays aware of remote changes — but applies use **`updates_available`** / owner review (§6), not silent overwrite. Manual upload mode blocks **push**, not necessarily **pull**.

---

## 3. Actors and roles

| Actor | Default role | Notes |
|-------|--------------|-------|
| **Desktop (gateway)** | Primary publisher; syncs with web via **bidirectional** LWW by default | Owns git push, Turso push, migrations, publish |
| **Web (apps.papr.ai)** | **Writer by default** — always `bidirectional` unless explicitly opted out | `/api/db/read`, `/api/db/write`, `/api/db/exec` — **forms and web edits must keep working** |
| **Cloud agent (sandbox)** | Temporary writer during cloud runs | Pull at start, debounced push during run, final push at end |
| **Other desktop (same namespace)** | Potential git writer | Remote changes require **owner review** before merge (§8) |
| **GitHub** | Code transport + history | Not a merge arbiter by itself |
| **Turso** | Row transport + cloud replica | Authority determined per linked source (§4) |

---

## 4. Writer authority (per linked source)

Each entry in `apps/{id}/data-sources.json` may declare who may write rows. **Product default: web can always write.** Do not regress the bidirectional web behavior shipped in existing apps (forms, `/api/db/write`, web edits).

### Default (do not change)

**Absent `writeAuthority` = `bidirectional`.** Web users can read and write. Desktop syncs both ways with LWW merge. This is the normal case for ~100% of apps.

```jsonc
{
  "sources": [
    {
      "alias": "joe",
      "type": "sqlite",
      "dbId": "db-0ff146f4-…"
      // omit writeAuthority → bidirectional (DEFAULT — web can write)
    }
  ]
}
```

| Value | Web `/api/db/write` | Desktop push | Desktop pull | Use when |
|-------|---------------------|--------------|--------------|----------|
| **`bidirectional`** (**default**) | **Allowed** ✅ | Pushes rows | **Always** pulls delta first | **All apps unless explicitly opted out** — forms, CRM, dashboards with web input |
| **`desktop`** (rare opt-in) | Rejected (403) | Pushes rows | Pulls before push | **Only** when owner explicitly wants display-only web (no forms, no web mutations) |
| **`cloud`** (rare) | Allowed | Does not push rows | Pulls only | Cloud agent / sandbox is source of truth |

**⚠️ Do not implement or document `desktop` as a default or migration target.** Sync work must preserve web write for all existing and new apps unless the user explicitly sets `"writeAuthority": "desktop"`.

**Legacy `role` field:** Deprecated. `scratch` sources remain local-only (no Turso sync) and must show **“not synced by design”** in UI.

**Per-user isolation:** Registry `isolation: "per-user"` (Turso `d-{id8}-u-{user8}`) avoids cross-user row conflicts without writer IDs.

### Enforcement (bidirectional-first)

- **Default path:** Web `/api/db/write` and `/api/db/exec` **always allowed** when `writeAuthority` is absent or `bidirectional`.
- **Desktop:** Pull-before-push always (remove “skip pull when local dirty”) so web edits are not silently overwritten.
- **`bidirectional`:** LWW merge on conflict; log and surface losses (Phase 2+).
- **`desktop` (opt-in only):** Cloud App Host returns 403 on web write — implement only when field is explicitly set, never by default.

---

## 5. Row conflict policy

### Platform columns (agents never manage these)

| Column | Purpose |
|--------|---------|
| `_papr_created_at` | Set once on insert |
| `_papr_updated_at` | Bumped on every user update |
| `_papr_row_version` | Monotonic integer; primary conflict signal |

**No `_papr_updated_by` in v1.** Version + timestamp is sufficient for LWW. Add writer ID only when audit or owner-wins-tie policies are product requirements.

### Merge rule (`bidirectional` and routine sync)

1. Compare `_papr_row_version` — higher wins.
2. If equal, compare `_papr_updated_at` — newer wins.
3. If columns absent (legacy table), **backfill on first sync** then apply rules. Until backfill: treat as needs-migration, not silent full overwrite.

### Deletes

- **Routine path:** `_papr_sync_log` records `delete` ops; delta push/pull propagates deletes.
- **Forbidden:** Full table replace (bootstrap / full pull / snapshot fallback) as routine path — causes delete resurrection (§9).
- **Future:** Tombstone rows for bulk repair paths if explicit bootstrap is required on non-empty sides.

### `desktop`-authority sources (rare opt-in only)

Only when `"writeAuthority": "desktop"` is **explicitly set**: web cannot write → no row conflicts from web. Not the default; do not apply to existing apps.

---

## 6. Git (code) policy

### Job path spelling (Sync V3 — REQUIRED)

Three layers use different casing **on purpose**. Agents and tools must not conflate them:

| Layer | Path | Notes |
| --- | --- | --- |
| Desktop local disk | `$PAPR_HOME/Jobs/{jobId}/` | Capital **J** — all job tools, schedulers, `edit_file` |
| Per-app GitHub repo | `jobs/{jobId}/` | Lowercase — writer ops map local → repo on app flush |
| Legacy namespace git | `Jobs/{jobId}/` | Capital **J** — read fallback until migration completes |

Memory server reads app-repo `jobs/` first, then legacy namespace `Jobs/`. Desktop never writes lowercase `jobs/` to local disk.

### What travels via git

**Sync V3 (linked jobs + metadata):**
- App source at **per-app repo root** (via writer ops — not `apps/{id}/` in namespace monorepo)
- Linked job **code** at `jobs/{jobId}/` in the app repo (config-only `job.json`; runtime stripped)
- Schema-owner migrations at `databases/{slug}/migrations/` in the app repo
- **Job + database registries (`jobs.json`, `databases.json`):** **Mongo authoritative** — desktop dual-writes on save ([`MetadataRegistryClient`](../src/gateway/services/syncV3/MetadataRegistryClient.ts)). Namespace git **`data/jobs.json` and `data/` are no longer pushed** on app flush (2026-08-18). Legacy namespace git `data/` remains a **read fallback** until migration completes.

**Legacy namespace git (being retired):**
- `apps/{id}/` (source, dist, backend bundle, linked-databases.json, revision marker) — **superseded by per-app repos for linked apps**
- Dependent `Jobs/{id}/` folders — **no longer pushed**; fallback read path only
- `data/` registry JSON — **read fallback only** (not written by desktop after Phase 4.6 cutover)
- `workspace/`, other index files

Absolute `dbPath` values are stripped before commit (`scrubAppDataSourcesForGitSync`).

### Multi-device / remote changes — owner decides

**Do not** silently merge remote git with `merge -X ours`.

| Situation | Behavior |
|-----------|----------|
| Fast-forward pull | Apply silently |
| Remote ahead — **legacy cloud runtime metadata only** (`Jobs/*/job.json` status fields, `data/jobs.json` runtime, `data/cloud-repo-head.txt`) | **Ignored** — job runtime is always off git; runtime arrives via **dispatch SSE** (primary) or legacy heartbeat `pendingCloudRuns`; legacy git-only status commits may be auto-merged once to linearize history |
| Remote ahead — **app/job source code** or mixed changes | Status: **`updates_available`** — in-app **Merge remote changes** (`POST /api/sync/apply-updates`); then Upload now |
| Owner / agent accepts (code changes) | Same as merge button — stash, merge `origin/main`, restore local edits |
| Owner / agent publishes | Upload now / `push_cloud_sync` after review (metadata-only remote no longer blocks) |

Cloud job runs while desktop sleeps **used to** write `job.json` status into git — that was **not** “app code ahead.” Legacy namespaces may still contain those commits; desktop may auto-merge them once to linearize history. **Sync V3:** Cloud no longer writes job runtime to git; desktop applies runtime via **dispatch SSE** (or legacy heartbeat fallback) and ignores legacy git-only status as non-blocking.

**Job runtime off git (always on — no env opt-out):** Git tracks job **definitions** only (config-only fields in `job.json` / local `jobs.json` index). Runtime (`status`, `lastRunAt`, `scheduleState.nextRunAt`, …) lives in gitignored `Jobs/{id}/job.runtime.json` locally. Memory server: `JOB_RUNTIME_GIT_DUAL_WRITE` defaults off. **Bidirectional sync via memory server:**

| Direction | Mechanism |
|-----------|-----------|
| Cloud → desktop | **Primary (Sync V3):** SSE `GET /v1/cloud/runtime/dispatch/stream` → `JobRuntimePatch` ([`runtimeDispatchSubscriber.ts`](../src/gateway/services/syncV3/runtimeDispatchSubscriber.ts)). Heartbeat `pendingCloudRuns` drain **removed** — dispatch SSE only |
| Desktop → cloud | `POST /v1/cloud/runtime/job-runtime/upsert` after local `setJobStatus` |
| Fresh device hydrate | `GET /v1/cloud/runtime/job-runtime` on gateway startup → LWW merge into local runtime files |
| Scheduled jobs (Mac asleep) | **Cloud scheduler** (memory server, `CLOUD_SCHEDULER_ENABLED=1`) fires cloud-capable jobs; desktop **defers** local scheduler ticks for the same jobs when dispatch is on ([`cloudSchedulerAuthority.ts`](../src/gateway/utils/cloudSchedulerAuthority.ts)) |

Local status writes do not enqueue git sync. **Mongo is authoritative for runtime**; **Mongo is authoritative for job/database registries** (dual-write desktop). Git is authoritative for app + linked job **source code** in per-app repos only.

Agent guidance: when `updates_available` (code on remote), summarize remote changes and ask before pushing local edits.

### Auto git sync vs manual guarantee

See **§2 Upload mode** for settings. Summary:

| Mode | Behavior |
|------|----------|
| **Auto** (default) | Watchers mark dirty → debounce + max-wait → push (§7, §7.2) |
| **Manual** (user opt-in) | Watchers mark dirty → status `pending (manual)` → **no push** until Upload now / agent |
| **Upload now / `push_cloud_sync`** | **Always available** — guaranteed full pipeline (§12.1), regardless of auto/manual |

Auto sync improves timeliness for users who want it; manual mode supports **local test-first** workflows. Upload now is always the explicit “ship it” action.

### Fork, track, and contribute-back (PR model)

**Decision:** Contribute-back uses a **git PR on the owner’s `papr-work` repo**, not metadata-only change requests. The owner reviews **actual code diffs** and merges like any other git change.

#### Install modes (unchanged)

| Mode | Contributor’s local copy | Upstream |
|------|--------------------------|----------|
| **Fork** | Independent app ID; normal git/Turso sync to **contributor’s** namespace repo | Owner repo unchanged until PR merged |
| **Track** | Linked copy; manual **Updates** pull from owner; normal sync for local edits | Owner repo is source of truth for pulls |

Contributor git/Turso sync is **never held** while a PR is open — they work in their sandbox. Upstream changes only via **merged PR** (or owner’s own edits).

#### Propose → PR flow (target — replaces metadata-only v1)

```
Contributor edits fork locally
    ↓
Contributor clicks Propose (or agent: submit_cloud_app_change)
    ↓
Desktop pushes branch to owner's papr-work:
  branch: contrib/{lineageId}/{shortId}
  paths:  apps/{forkId}/ (+ dependent Jobs/ if changed)
    ↓
Open PR against owner's default branch (GitHub API / memory server)
    ↓
Owner reviews diff (GitHub and/or in-app PR panel)
    ↓
Owner merges PR (or rejects → close PR)
    ↓
Owner desktop: git pull → apply migrations locally → Turso push (schema then rows)
    ↓
Publish + cache refresh when joint readiness passes (§12.1)
```

**PR must include:** file diffs for app source, `dist/`, `backend/bundle.json`, `data-sources.json`, `linked-databases.json`, and **`data/databases/{slug}/migrations/*.sql`** when schema changed.

**PR must NOT rely on:** contributor’s `installedAppId` existing on the owner’s machine (legacy `mergeForkIntoSource` local-folder copy **removed** in Phase 3b).

#### Scoped access

- Memory server issues a **short-lived, path-scoped git token** for `contrib/*` branches on the owner’s repo, **or** contributor forks the owner repo and opens a cross-repo PR (GitHub-native).
- Token allows **branch push + open PR**, not force-push to `main` or delete owner history.

#### Owner approve = merge, not re-implement

| Action | Effect |
|--------|--------|
| **Merge PR** | Code lands in owner’s `papr-work`; normal owner sync pipeline runs (§12.1 ordering) |
| **Reject PR** | PR closed; no upstream change |
| **Request changes** | (Future) review comments; contributor pushes to same branch |

#### Track-mode contributors

- **Pull upstream:** manual “Updates” (snapshot merge with conflict detection) — separate from PR.
- **Propose downstream:** same PR flow as fork mode — branch on **owner’s** repo, not a notification ticket.

#### Current gap (v1 — do not rely on)

Today’s `submit_cloud_app_change` sends **title + description only**; approve tries to copy files from a local fork folder on the **owner’s disk** and fails cross-user. Treat as **bug/placeholder** until PR flow ships. See §9 #11.

---

## 7. Timing contract

| Path | Debounce | Max-wait (forced flush) |
|------|----------|-------------------------|
| App/job code → git (legacy namespace) | 30–45s | 5 min |
| Per-app repo (writer ops) | Debounced via AppSaveWatcher (~35s) | Upload now |
| Cloud sandbox app code → writer ops | 15s debounce (`CLOUD_AGENT_WRITER_DEBOUNCE_MS`) | 120s max-wait + run/turn end flush |
| `workspace/` → git (legacy namespace) | 15s | 2 min |
| ~~`data/` registry → git~~ | **Removed** — Mongo dual-write only | — |
| DB write → Turso (via workspace log) | 30s debounce + watcher | **120s required** max-wait |
| Job completion → Turso | — (watcher primary) | — |
| Manual Upload now | 0 | — |
| Pull | Every 5 min + heartbeat 60s | — |
| Job runtime dispatch (Sync V3) | SSE stream (persistent while connected) | Heartbeat 60s legacy fallback only when dispatch disabled |
| Convergence check | Every 5 min per linked source | — |

**Max-wait rule:** Sliding debounce alone is insufficient — a long-running job must not defer Turso push indefinitely.

### Max-wait under heavy load

Max-wait means **“start flushing now”**, not **“finish everything instantly.”** Large backlogs must not OOM the desktop, hammer Turso, or falsely report green.

#### Target behavior (SyncCoordinator — Phase 5)

| Concern | Contract |
|---------|----------|
| **Trigger** | When max-wait fires, enqueue a flush for that layer. Debounce timer resets for *new* edits after flush **starts**, not after it **finishes**. |
| **Serial execution** | Git: one commit/push at a time (existing queue). Turso: one linked source at a time, one table/batch at a time inside push (existing queue + interval). **No parallel bombs** across layers for the same app. |
| **Chunking** | Turso row push processes oplog in bounded batches (by entry count / byte size). Never load an entire multi-GB `.db` into memory. |
| **Backpressure** | If a flush is already running, additional max-wait triggers **extend the same run** or queue behind it — do not spawn duplicate pushes. |
| **Status while backlogged** | UI: **`syncing`** with progress (`Git: pushing…`, `Turso: 3/19 tables`, `queue: 4 sources`). **Never `synced`** until the current flush completes and verify passes (§10). |
| **Partial failure** | Failed chunk/source stays **dirty**; completed chunks marked synced. Combined error returned; user can retry Upload now. |
| **Rate limits** | Turso provisioning / API rate limits: exponential backoff (30s → 120s cap), queue preserved, status **`syncing (rate limited)`** — not silent drop. |
| **Upload now** | Runs until complete or hard failure; may take minutes for large apps. Show progress; do not timeout the UI at 30s. |
| **Memory server / host** | Unaffected by desktop max-wait — they serve last **verified** bundle (§12.1). New code does not go live until owner pipeline completes. |

#### What we do NOT do

- ❌ Drop dirty flags because max-wait fired once
- ❌ Mark overall `synced` when git finished but Turso queue still has 10 sources
- ❌ Parallel Turso pushes for all linked DBs on max-wait (rate-limit storm)
- ❌ Full-table bootstrap as a “catch up fast” fallback under load (§12.1)

#### Today (honesty)

Max-wait for Turso is **specified but not fully implemented** (debounce resets on every write — §9 #9). Turso queue is serial with rate-limit backoff. Git queue is serial. No progress UI for multi-table push yet.

### Efficient dirty detection (two-tier)

**Principle:** Never full-scan a large repo or DB on every periodic tick. **Watch → mark dirty → confirm → transfer delta only.**

#### Three layers

| Layer | Purpose | Cost |
|-------|---------|------|
| **1. Cheap dirty signal** | “Might need sync?” | O(1) — watcher, mtime, oplog cursor, git folder hash |
| **2. Confirm (optional)** | “Really changed?” | Medium — fingerprints, schema check (only if layer 1 fired) |
| **3. Transfer** | Push/pull payload | Incremental — git commit of changed paths; oplog since cursor |

#### Git (today)

| Mechanism | Storage | Behavior |
|-----------|---------|----------|
| Per-folder **content hash** | `.cloud-sync-state.json` | `hasItemChanged(path)` — skip commit if unchanged |
| Watchers → queue | `CloudSyncService` | Only enqueue changed `apps/` / `Jobs/` folders |
| Manual mode (target) | Per-app `uploadMode` | Still hash + mark dirty; **skip queue push** until Upload now |

#### Turso (today → target)

| Mechanism | Today | Target (Coordinator) |
|-----------|-------|---------------------|
| Watcher on `.db`/WAL | Schedules debounced push | + **`markDbDirty(syncKey)`** (instant) |
| Dirty check | **Full table fingerprints** (scans rows — slow) | **Oplog cursor first:** `MAX(_papr_sync_log.id) > lastPushedLogId` |
| Skip if clean | `linkedSourceNeedsPush()` → false | If !dirty flag && cursor unchanged → **skip** (no remote round-trip) |
| Transfer | Oplog delta since `lastPushedLogId` | Same ✅ |
| Pull | Delta since `lastPulledLogId` | Cheap check: `remoteMaxLogId > lastPulledLogId` before pull |
| Verify (5 min) | — | Full fingerprints / row hashes (§10) — not on every debounce |

**Ideal Turso dirty order:**

1. Watcher fired or `markDbDirty`? If no → **skip** (milliseconds).
2. Local log ahead of `lastPushedLogId`? → **push oplog batch** (no full table scan).
3. Fingerprint / remote schema check → first push, post-migration, Upload now verify, or periodic convergence only.

#### State files (cursors)

| File | Tracks |
|------|--------|
| `~/Papr/.cloud-sync-state.json` | Git: per-path content hash, dead-letter |
| `~/Papr/data/.turso-sync-state.json` | Turso: `lastPushedLogId`, `lastPulledLogId`, `lastSeenIndexVersion`, `tableFingerprints`, quarantine |

#### Turso sync index (discovery hint)

Desktop heartbeat polls one workspace index DB (`sync-index`) for linked replicas that advanced since last reconcile:

| Layer | Role |
|-------|------|
| **`sync-index.sync_sources`** | One row per linked replica short name (`j-{id8}`, `d-{id8}`, …). `version` bumps after any writer pushes that replica (direct Turso or via memory `turso-db-changed`). |
| **`lastSeenIndexVersion`** (local) | Per linked source cursor — advanced after successful push/pull reconcile. |
| **Per-DB CDC** (`_papr_sync_meta`, `_papr_sync_log`) | **Source of truth** for row deltas. Index only answers “which DBs to open?” |

**Writer contract:**

| Writer | How sync-index is bumped |
|--------|--------------------------|
| **Desktop gateway** | Direct Turso write to `sync-index` (same token API as linked DBs) after push |
| **Cloud agent gateway** | Direct Turso write after push |
| **Cloud app host** (web writes) | `POST /v1/cloud/runtime/turso-db-changed` — bumps sync-index (hint only; desktop polls on heartbeat, CDC is source of truth) |
| **Memory cloud job runner** | In-process bump after Turso push |

The `sync-index` database is a normal Turso replica — token via `POST /v1/cloud/databases/token` with `database: "sync-index"`. Memory server HTTP is only for cloud-side writers that use runtime session auth, not for desktop/cloud-agent (they bump Turso directly).

**Rules:**

1. Index advanced + local dirty → **push first**; update index cursor after success so own push does not spuriously pull.
2. Index advanced + local clean → reconcile via `syncLinkedSourceFromCloud`.
3. Desktop Turso hydration uses **sync-index poll** on heartbeat (`syncTursoFromSyncIndex`); job runtime patches use **dispatch SSE** when enabled (heartbeat `pendingCloudRuns` is legacy fallback).


Dirty tracking **still runs** in manual mode (user sees “pending changes — Upload when ready”). Only **auto push** is suppressed — efficient skip paths still apply when they eventually click Upload now.

---

## 8. What each action guarantees

| Action | Guarantees on success | Explicitly NOT guaranteed |
|--------|----------------------|---------------------------|
| **Upload now / `push_cloud_sync({ appId })`** | **Sync V3:** Ordered pipeline — local migrate → workspace log row ship → writer ops (app + linked `jobs/` + owner migrations) → verify → publish. **No namespace git push** for `data/jobs.json`, `data/`, or linked `Jobs/{id}/`. Errors reported per layer. | Open browser tabs refreshed; scratch/unlinked DBs; other apps’ folders |
| **Auto sync** | Best-effort convergence within debounce + max-wait (§7.1) | Atomic cross-layer ordering until SyncCoordinator ships; correctness if bulk fallback triggers (until Phase 1 fix) |
| **Periodic pull** | Fetches remote git + Turso deltas | Auto-merge of conflicting git hunks; applying remote rows that lose LWW on bidirectional sources without logging |
| **Status: synced** | Last operation returned success for that layer | Content equality until convergence checker runs (§10) |
| **Status: verified** | Content hash + row counts match local vs Turso | — (target state post Phase 4) |

**Git and Turso are independent on manual push:** Git failure does not block Turso push (and vice versa); both errors are surfaced.

---

## 9. Known limitations (honesty clauses)

These are current gaps being closed per [`SYNC_ARCHITECTURE_V2.md`](./SYNC_ARCHITECTURE_V2.md). Until fixed, treat as documented behavior.

| # | What can go wrong | Mechanism today | Target fix |
|---|-------------------|-----------------|------------|
| 1 | Web rows overwritten when desktop dirty | Pre-push pull skipped | §4: pull always + LWW merge/logging for `bidirectional` |
| 2 | Remote git changes lost on conflict | `merge -X ours` | §6: `updates_available` + owner review |
| 3 | Local rows wiped by stale remote | Full pull replaces tables wholesale | Oplog-only routine; explicit bootstrap only |
| 4 | Deleted rows resurrect | Bulk copy without tombstones | Tombstones + no silent bulk |
| 5 | Legacy tables: last pull wins entire table | No `_papr_row_version` | Backfill on first sync |
| 6 | App folder never syncs again | Git dead-letter after 3 failures | Visible **failed** on publish bar + retry |
| 7 | Scratch / unlinked DB invisible | Excluded from Turso discovery | UI: “not synced by design” |
| 8 | False green chip | Blended `overall` status | Per-layer status (§10) |
| 9 | Turso push never fires during long job | Sliding debounce reset | Max-wait 120s (§7) |
| 10 | Schema drift with green Turso status | Ledger says migrated, tables missing | Post-push schema verify |
| 11 | Contribute-back is metadata-only | No code in change request; merge reads local fork on owner disk | §6 PR model on owner repo |
| 12 | Git lands before Turso schema+rows | Independent push layers; publish after git | §12.1 ordering + joint version gate |
| 13 | Max-wait dumps entire backlog at once | Not implemented; debounce starvation | §7.1 chunking + backpressure |
| 14 | No manual upload mode | Auto push always when cloud on | §2 per-app `uploadMode` + global `cloudAutoUploadEnabled` |
| 15 | Fingerprint scan on every debounce | `isJobDbDirty` full row hash | §7.2 oplog cursor first |

---

## 10. Verification (“synced” must be earned)

### Post-push verify (Phase 3)

- **Git:** Confirm remote SHA matches local HEAD for pushed paths.
- **Turso:** Confirm remote has all local tables; spot-check row counts per linked alias.
- **Migrations:** `migrationSatisfiedOnRemote()` must pass before Turso status = synced.

### Convergence checker (Phase 4)

Every 5 minutes per linked source, compare per table:

```
(row_count, hash(primary_key ‖ _papr_row_version ‖ _papr_updated_at))
```

local vs Turso. Status:

- **Verified N min ago** — content match
- **Drift detected in `{table}`** — action required (repair / explicit bootstrap)

Fingerprints alone are insufficient (empty remote shells can match “has tables”).

### Joint code/data version (Phase 4, optional)

Bundle declares required schema version; host may serve prior bundle until Turso reports that version — prevents “new UI, old rows.”

---

## 11. UI contract

Publish bar / sync popover must show **per layer**:

| Layer | States |
|-------|--------|
| **Git** | synced · pending · uploading · **updates available** · **failed (dead-letter)** · error |
| **Turso** (per alias) | synced · pending · **syncing (N/M tables)** · schema drift · quarantined · **rate limited** · **not linked** · error |
| **Publish** | synced · republishing · drift · **not web-ready** · error |
| **Cache** | fresh · refresh browser (informational) |
| **Contribute (fork)** | PR open · PR merged · PR rejected · (owner) **incoming PR** |

**Overall** = worst layer, but breakdown always visible. Poll every 10s when any layer pending (not 25s).

Dead-letter git folders must appear on the **app publish bar**, not only Settings → Cloud Sync.

---

## 12. Schema migrations vs row sync

| Concern | Owner | When applied |
|---------|-------|--------------|
| **Schema** (tables, columns) | Agent SQL in `migrations/000N.sql` | Local: job run + pre-Turso push; Remote: replay on Turso push |
| **Row metadata** (`_papr_*`) | Platform (lazy on sync) | First CDC trigger install local + remote |
| **Row data** | Jobs, bash, web (per authority) | CDC delta push/pull |

Agents must **never** create or edit `_papr_created_at`, `_papr_updated_at`, or `_papr_row_version`.

Migration ledger entry without matching schema = **not synced** until repair runs.

### Cross-layer drift (Git ↔ Turso ↔ publish)

Git, Turso, and publish are **independent transports** today. They can diverge. The contract defines ordering, gates, and failure modes so the web app never silently assumes data that is not there.

#### Layer coupling matrix

| Layer carries | Does NOT carry |
|---------------|----------------|
| **Per-app repo (writer ops)** | App code, `dist/`, migrations **SQL files**, linked job code at `jobs/{id}/` | SQLite `.db` files, live row data, job/database **registry JSON** |
| **Mongo (metadata registry)** | `jobs.json` index, `databases.json` registry (authoritative) | Source files, row data |
| **Workspace log → Turso** | Row data, remote schema (via log replay), CDC entries | App TypeScript/UI |
| **Legacy namespace git** | Read fallback for unmigrated namespaces only | **Not written** for registries or linked job folders after Phase 4.6 cutover |
| **Publish catalog** | Share URL, visibility, vault allowlist | Rows or source files |
| **Edge cache** | Bundled JS/CSS the host last served | DB contents |

#### Target flush ordering (Upload now / post-PR-merge)

For a single app, **readiness for web** requires this order:

```
1. Local SQLite: apply pending migrations (jobs / pre-push hook)
2. Workspace log: ship local `_papr_sync_log` row ops → memory → Turso (schema events included)
3. Materialize: catch up remote log entries into local SQLite (other devices / cloud writes)
4. Writer ops: push app source + linked `jobs/{id}/` + owner `databases/{slug}/migrations/` to per-app repo
5. Verify: remote table set + migration ledger + spot row counts (§10)
6. Publish catalog reconcile + cache revision notify
```

**Rule:** Do not report **web-ready** until steps 2–5 pass for all linked sources. Writer **synced** with Turso `schemaDrift` or `pending` = **overall not ready**.

**Not in Upload now (Sync V3):** namespace git push of `data/jobs.json`, `data/databases.json`, or linked `Jobs/{id}/` — registries go to Mongo; job code goes to per-app repo via writer.

#### Drift scenario A — Git ahead of Turso (new UI, old/no data)

**Example:** Git push lands `dist/app.js` that queries `social_posts`; Turso remote never got `0002_social.sql` or row bootstrap.

| Phase | Today (risk) | Target |
|-------|--------------|--------|
| User opens web app | New bundle loads; `/api/db/read` → **no such table** or empty | Host serves **previous bundle** until Turso reports `migrationSatisfied` + required tables |
| Status chip | Can show git **synced** while Turso **pending** | Per-layer breakdown; overall **`not ready for web`** |
| Recovery | Manual Upload now; Turso migration repair | Auto: Turso push replays migrations then rows; verify before publish refresh |

#### Drift scenario B — Turso ahead of Git (rows exist, old UI)

**Example:** Rows pushed to Turso; git push failed or deferred.

| Phase | Today | Target |
|-------|-------|--------|
| Web app | Old UI may still run; data exists in Turso | Acceptable short-term; status **Git: error**, **Turso: synced** |
| New UI features | Missing until git lands | Owner fixes git push; no row rollback |

#### Drift scenario C — Schema migrated, rows not (within Turso)

**Example:** Migration ledger says `0002` applied; table exists on remote but empty; local has 7K rows. Or: table shell exists, columns mismatch.

| Detection | `schemaDrift`, `localTableCount > remoteTableCount`, verify hash mismatch |
| Push behavior | Migrations run **before** oplog; row push skips/quarantines tables that fail schema prep |
| Status | **`pending`** or **`schema drift`** — not `synced` |
| Recovery | Explicit repair: re-run migration if ledger/schema disagree; then delta push. **No silent full pull** (§9 #3). Bootstrap only when operator confirms empty side. |

#### Drift scenario D — Rows written, schema not (within Turso)

**Example:** Local job INSERTs into `social_posts` before migration `0002` applied locally; or web writes column that does not exist on remote yet.

| Local | Migration runner should apply pending SQL before job writes (job pre-run hook). If not: local SQLite may error — fail loud locally. |
| Remote push | Row oplog for unknown table → push **fails** for that table; source stays dirty; error names table + missing migration |
| Web | `/api/db/write` returns SQL error until remote schema catches up — **never 200 with silent drop** |

#### Drift scenario E — Git migration file added, Turso never replayed

**Example:** Agent adds `data/databases/joe/migrations/0003_peers.sql`, commits via git; Turso push skipped or failed.

| Git | Contains SQL file ✅ |
| Turso | Remote missing tables/columns ❌ |
| Target | Turso push **always** replays git-tracked migrations before rows; `migrationSatisfiedOnRemote()` false → block web-ready |
| Agent | After adding migration SQL: **Upload now**; check Turso layer, not git alone |

#### Joint code/data version gate (Phase 4)

Bundle declares **`requiredSchemaVersion`** (max applied migration id). Cloud App Host:

- If Turso remote schema version **<** bundle requires → serve **previous** bundle + `503`/banner “Database syncing…”
- When Turso catches up → serve new bundle

Prevents scenario A at the edge without requiring simultaneous git/Turso atomic push.

#### PR merge adds a step

When owner merges contributor PR: treat as **git pull + full Upload now pipeline** (ordering above). Do not auto-publish until Turso verify passes — contributor may have included migration SQL without owner having run local/Turso migration yet.

---

## 13. Agent guidance (summary)

1. After code or migration changes: **Upload now** on the app (or `push_cloud_sync`) — do not assume auto-sync has finished.
2. Check `/api/sync/items?appId=` — read **each layer**, not just `overall`.
3. For new apps linking a registry DB: **omit `writeAuthority`** — web must remain writable (forms, edits). Never set `desktop` unless user explicitly asks for a display-only web app with no form input.
4. When git status is `updates_available`: summarize remote commits; **do not push** until owner accepts or rejects.
5. Cloud sync OFF: do not call cloud publish/sync tools; use local tools and export if sharing is needed.
6. Joe Coffee class bugs (remote missing tables): run Upload now; if schema drift persists, explicit repair/bootstrap — do not delete local data.
7. Fork/track contribute-back: **open a PR on the owner’s repo** (branch with code diff) — never assume title/description alone is enough.
8. After PR merge (owner) or migration SQL in git: run full pipeline — local migrate → Turso schema → Turso rows → verify → publish.
9. If git shows synced but Turso shows schema drift or pending: tell user **web is not ready**; do not claim cloud is up to date.
10. Respect **manual upload mode** — do not auto `push_cloud_sync`; tell user to Upload now when they are ready.
11. Respect **per-app `cloudEnabled: false`** — app is local-only; no cloud tools for that app.
12. **Job runtime:** cloud → desktop via **dispatch SSE** when enabled; do not assume heartbeat `pendingCloudRuns` is the primary path.
13. **Registries:** job/database metadata lives in **Mongo** (dual-write on save) — not namespace git `data/`.

---

## 14. Implementation priority

| # | Item | Phase |
|---|------|-------|
| 0 | This contract + agent SystemPrompt alignment | Done (doc) |
| 1 | **Preserve bidirectional web write** (default); pull-before-push + LWW for `bidirectional` | 1–2 |
| 2 | Oplog-only routine; kill silent bulk fallback | 1 |
| 3 | Tombstones / delete policy | 1 |
| 4 | Per-layer status + dead-letter on publish bar | 3 |
| 5 | Post-push verify + convergence hash | **Removed** — `postPushVerify` deleted; writer `parentHash` + workspace log replay replace verify-at-push |
| 6 | Max-wait on Turso debounce; legacy row-version backfill | 1–5 |
| 7 | Git `updates_available` (owner review) | 3 |
| 8 | **Contribute-back via PR** on owner `papr-work` (replace metadata-only) | 3 |
| 9 | **Sync mode settings** — global `cloudAutoUploadEnabled` + per-app `uploadMode` / `cloudEnabled` | **Done** |
| 10 | **Two-tier dirty detection** — `markDbDirty` + oplog cursor before fingerprints | **Done** — `tursoSyncState.ts` fast path |
| 11 | Cross-layer ordering + web-ready gate (§12.1) | **Done** — `flushAppNow.ts`, `webReady.ts`, publish layer API |
| 12 | Watchers → SyncCoordinator queues | **Done** — `SyncCoordinator.ts`, wired watchers + AppService |
| 13 | Full-stack E2E test | 6 |
| — | `writeAuthority: desktop` web 403 (opt-in only) | **Defer** — only if product requests display-only mode |

See [`SYNC_ARCHITECTURE_V2.md`](./SYNC_ARCHITECTURE_V2.md) for code references and acceptance criteria:

| Contract item | Architecture section |
|---------------|---------------------|
| PR contribute-back (§6) | [§2.4 Contribute-back PR architecture](./SYNC_ARCHITECTURE_V2.md#24-contribute-back-pr-architecture) |
| Max-wait under load (§7.1) | [§2.5 Max-wait and backpressure](./SYNC_ARCHITECTURE_V2.md#25-max-wait-and-backpressure) |
| Cross-layer drift (§12.1) | [§2.6 Cross-layer flush ordering](./SYNC_ARCHITECTURE_V2.md#26-cross-layer-flush-ordering) |
| Efficient dirty detection (§7.2) | [§2.7 Efficient dirty detection](./SYNC_ARCHITECTURE_V2.md#27-efficient-dirty-detection) |
| Sync modes / manual upload (§2) | [§2.8 Sync mode settings](./SYNC_ARCHITECTURE_V2.md#28-sync-mode-settings) |
| Phased rollout | [§3 Phased plan](./SYNC_ARCHITECTURE_V2.md#3-phased-plan) |

---

## 15. Decisions log

| Date | Decision |
|------|----------|
| 2026-08-06 | Default `writeAuthority`: **`bidirectional`** — **web always writable**; absent field = bidirectional |
| 2026-08-06 | **`desktop` read-only web is rare opt-in only** — not a sync phase priority; do not regress web forms/edits |
| 2026-08-06 | Git remote changes: **owner review** (`updates_available`), not silent `-X ours` |
| 2026-08-06 | Row conflicts: **`_papr_row_version` + `_papr_updated_at` LWW**; no writer ID in v1 |
| 2026-08-06 | Auto upload: **on by default**, user may disable globally (`cloudAutoUploadEnabled`) or per-app (`uploadMode: manual`) |
| 2026-08-06 | Manual mode: **git + Turso coupled** per app — Upload now runs full pipeline; no split in v1 |
| 2026-08-06 | Per-app **`cloudEnabled: false`** for local-only apps within an otherwise synced namespace |
| 2026-08-06 | Dirty detection: **two-tier** — cheap watcher/cursor first, fingerprints on verify only (§7.2) |
| 2026-08-06 | Cloud OFF: **fully local**, no sync side effects |
| 2026-08-06 | Routine row path: **oplog only**; bootstrap **explicit** only |
| 2026-08-06 | Contribute-back: **PR on owner’s papr-work repo** (code diff + merge), not metadata-only |
| 2026-08-06 | Max-wait under load: **serial + chunked + backpressure**; never false green (§7.1) |
| 2026-08-06 | Cross-layer: **schema-before-rows**, joint web-ready gate (§12.1) |
| 2026-08-18 | **Metadata off namespace git:** `data/jobs.json` / `data/` not pushed; Mongo registry dual-write authoritative |
| 2026-08-18 | **Job runtime dispatch:** SSE `dispatch/stream` primary; heartbeat `pendingCloudRuns` legacy fallback (skipped when dispatch on) |
| 2026-08-18 | **Cloud scheduler authority:** desktop defers cloud-capable scheduled jobs when dispatch + Papr auth + cloud sync on |
| 2026-08-18 | **Row sync:** desktop fingerprint Turso CDC deleted; workspace log is sole routine push/pull path |

### Open (defer)

| Question | Notes |
|----------|-------|
| Multi-Mac conflict copies vs single-publisher doc | Depends on real 2-Mac usage; owner review may suffice |
| Move `dist/` out of git (server-side builds) | Medium-term; reduces git conflict surface |
| `_papr_updated_by` for audit | Add when product asks, not for v1 correctness |
