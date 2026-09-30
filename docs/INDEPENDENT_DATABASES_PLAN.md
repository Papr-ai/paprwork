# Independent First-Class Databases — Implementation Plan

**Status:** In progress — core phases implemented (2026-07-11); post-implementation checklist below  
**Repos:** `paprwork-v2` (primary), `memory` (Turso + cloud runtime)  
**Related:** `docs/TURSO_CHANGELOG_CDC_SYNC.md`, `docs/architecture/PORTABLE_BUNDLE_SPEC.md`, `docs/MINI_APP_BACKEND_ARCHITECTURE.md`

---

## Goal (one sentence)

Apps and jobs can read, write, and subscribe to databases that exist as independent resources — not owned by any single job — with correct behavior for local, cloud, and team-shared scenarios.

---

## What already exists (~3,900 lines)

The hard infrastructure is built. This plan is a **re-keying and gap-fill**, not a rewrite.

| Capability | File(s) | Status |
|---|---|---|
| App↔DB linking via `data-sources.json` | `appDataSources.ts` (282 lines) | ✅ Works |
| Primary source routing | `appDataSources.ts` + `DbRouter.ts` | ✅ Works |
| Local SQLite read/write | `DbQueryPool`, `appBackendDatabase.ts` | ✅ Works |
| Turso sync (push/pull/delta CDC) | `TursoSyncBridge.ts`, `tursoDeltaSync.ts`, `tursoSyncBridgeCore.ts` (~1,760 lines) | ✅ Works |
| Turso naming (`j-{jobId8}`) | `tursoDatabaseNaming.ts` | ✅ Works |
| Turso credential fetching | `TursoSyncBridge.fetchCredentials` | ✅ Works |
| Cloud fallback routing (local → Turso) | `DbRouter.ts` | ✅ Works |
| Cloud app writes for team members | `CloudAppHostService` → `TursoDbAdapter.write()` | ✅ Works |
| Sync state tracking | `tursoSyncState.ts` | ✅ Works |
| `APP_DB` / `JOB_DB` env injection | `jobAppDatabase.ts` | ✅ Works |
| DB path normalization | `dbPathNormalization.ts` (326 lines) | ✅ Works |
| Data contracts / schema validation | `DataContractService.ts` | ✅ Works |
| CDC sync log | `tursoSyncLog.ts` | ✅ Works |
| DB change events | `publishDbChanged` | ✅ Works |
| Bundle import/export with DB schemas | `BundleService.ts` | ✅ Works |
| Team access control | `resolveAccess()` in `CloudAppHostService` | ✅ Works |

**Everything is keyed by `jobId`.** That's the only structural problem.

---

## Current bugs (to fix immediately)

### Bug 1: Team writes get silently overwritten

```
Team member → CloudAppHostService.handleWrite() → writes to Turso
Desktop owner → local SQLite write → pushLocalDbToTurso → overwrites team writes
```

Push has no check for "has Turso changed since I last pulled?"

### Bug 2: Cloud job writes never reach desktop

```
Cloud job writes to Turso while laptop closed
Desktop wakes up → pullLinkedSourcesIfNeeded → onlyIfLocalEmpty: true → SKIP
Cloud changes never pulled. Next desktop push overwrites them.
```

### Bug 3: Unlink/delete destroys shared data

```
AppService.gcTursoTablesForRemovedJobs → deleteJobTursoDatabase(jobId)
If App A and App B share the same job DB, unlinking one destroys the Turso replica for both.
```

---

## Implementation — 4 Phases (~2 weeks)

### Phase 1: Fix sync bugs (1-2 days)

**Optimistic concurrency on push (~50 lines)**

Before `pushLocalDbToTurso`, check Turso's latest sync sequence. If it's ahead of our `lastPulledSequence`, pull first, then push. This prevents desktop from overwriting team writes or cloud job writes.

```
pushLocalDbToTurso(jobId):
  remoteSyncSeq = getTursoLatestSequence(jobId)
  if remoteSyncSeq > localLastPulledSeq:
    pullTursoToLocalDb(jobId)  // merge remote changes first
  // then push as normal
```

Files: `TursoSyncBridge.ts`, `tursoSyncBridgeCore.ts`

**Pull-after-cloud-run without guards (~30 lines)**

Change `CloudJobRunService.syncAfterCloudRun` to call `pullJob` without `onlyIfLocalEmpty`/`skipIfLocalDirty` guards. Delta sync log handles deduplication — only new entries since `lastPulledLogId` are fetched.

Files: `CloudJobRunService.ts`, `TursoSyncBridge.ts`

**Exit criteria:**
- Team member writes to shared app → desktop pulls those changes before next push
- Cloud job finishes → desktop pulls results without requiring empty local DB
- No data loss in push/pull ordering for any scenario

---

### Phase 2: `dbId` + Registry (2-3 days)

**Add `dbId` to `AppDataSource` (~50 lines)**

```ts
interface AppDataSource {
  // ... existing fields ...
  dbId?: string;  // NEW — stable identifier, independent of jobId
}
```

Generate deterministically from existing `jobId` for backfill: `dbId = "db-" + hash(jobId + alias)`. Write into `data-sources.json` on first access.

**Database registry (~200 lines, new file)**

Location: `$PAPR_HOME/data/databases.json`

```ts
interface DatabaseRegistry {
  schemaVersion: 1;
  databases: DatabaseRecord[];
}

interface DatabaseRecord {
  dbId: string;               // stable, immutable
  name: string;               // user-facing
  localPath: string;          // absolute path to data.db
  tursoShortName?: string;    // Turso database name (e.g., "j-a1b2c3d4")
  state: "active" | "deleted";
  deletedAt?: string;         // tombstone timestamp
  createdAt: string;
  isolation?: "shared" | "per-user";  // for Phase 4
}
```

One `DatabaseRegistryService.ts` with atomic writes, populated from existing `data-sources.json` entries on first boot.

**Re-key DbRouter + TursoSyncBridge (~60 lines changed)**

- `DbRouter.getTursoClient(jobId)` → also accept `dbId`, look up `tursoShortName` from registry
- `TursoSyncBridge.syncJobDatabase(jobId)` → accept `dbId` with `jobId` adapter for backward compat
- `tursoDatabaseNaming.ts`: add `dbTursoDatabaseName(dbId)` alongside existing `jobTursoDatabaseName`

**Deletion safety fix (~10 lines)**

`AppService.gcTursoTablesForRemovedJobs`: check registry for other consumers before deleting. Only delete Turso DB when zero references remain AND user explicitly confirms.

**Tombstoned deletion (~20 lines)**

When deleting, set `state: "deleted"` + `deletedAt`. On registry load, ignore deleted entries. Prevents resurrection if another device syncs stale state. Purge tombstones after 30 days.

**Exit criteria:**
- Every existing app keeps working (dbId backfilled transparently)
- Two apps can share a database without either "owning" it
- Unlinking an app never destroys data for other consumers
- Deleted databases can't be accidentally resurrected

---

### Phase 3: Standalone databases (1-2 days)

**`create_database` tool (~100 lines)**

Creates `$PAPR_HOME/databases/{dbId}/data.db`, registers in `databases.json`. No job required.

**`link_app_data_source` accepts `dbId` (~50 lines)**

Modify to accept `dbId` directly, without requiring a `jobId`. Looks up path from registry.

**Update `checkLinkedDataSources` (~20 lines)**

Allow sources without a `jobId` field.

**Events with `dbId` (~20 lines)**

`publishDbChanged` adds `dbId` to the event payload. Apps can subscribe by `dbId` instead of guessing which job wrote.

**Exit criteria:**
- App can have a database without any job existing
- Agent can create a database, link it to an app, and the app can read/write/subscribe
- Existing job-based apps continue working unchanged

---

### Phase 4: Per-user database isolation (1-2 days)

**The problem:** When User A publishes an app with `loginAccess: "team"`, all team members read/write the same database. There's no mode for personal-data apps (habit trackers, expense logs) where each user gets their own data.

**`isolation` flag (~10 lines)**

Add `isolation: "shared" | "per-user"` to `DatabaseRecord` and `AppDataSource`.

**Per-user Turso naming (~20 lines)**

When `isolation: "per-user"`, resolve database name to `{tursoShortName}-u-{userId}` instead of just `{tursoShortName}`.

```ts
// TursoDbAdapter.ts — already has userId flowing through
function resolveTursoDatabaseName(record: DatabaseRecord, userId: string): string {
  if (record.isolation === "per-user") {
    return `${record.tursoShortName}-u-${userId.slice(0, 8)}`;
  }
  return record.tursoShortName;
}
```

**Lazy provisioning (~50 lines)**

First time a new user hits a per-user app, create their Turso database from the schema (empty tables, no data). The credential provider already scopes by userId.

**Exit criteria:**
- App published as per-user: User B sees empty database, not User A's data
- App published as shared: all users see same data (existing behavior)
- Schema applied consistently across all per-user instances

---

## Deliberately NOT building (with rationale)

| Item | Why not | When to reconsider |
|---|---|---|
| **Lease service + fencing tokens** | "Pull before push" (Phase 1) solves multi-writer ordering. No distributed lock needed. | If Turso's concurrent writes produce actual corruption (they shouldn't — Turso handles this natively) |
| **Authority-flip (desktop vs cloud)** | Desktop-authoritative + optimistic concurrency covers all current scenarios. | When users want databases that ONLY cloud jobs write to and desktop is read-only |
| **Credential lifecycle / minting / revocation** | `fetchCredentials` through memory server already works. Per-DB token scoping isn't needed for single-user or team-within-org. | When publishing apps to untrusted users outside your org |
| **`PAPR_DATABASES_JSON` env var** | Individual `$DB_ALIAS` env vars work. Most apps have one database. | When multi-database jobs become common enough to justify the abstraction |
| **Sequenced reconnectable events** | "Reload on reconnect" works. SSE drops are handled by full re-query. | When apps are complex enough that full reloads are expensive (>5s) |
| **Schema migration locking / checksums** | `DataContractService` already validates schemas on link. Agent creates both job and app, so mismatches are rare. | When community bundles make schema conflicts common |
| **Bundle create-vs-bind** | Create-new is the safe default. | When users ask to share databases across installed bundles |
| **Multi-device registry merge rules** | Git handles file merging. Same-record conflicts are unlikely on single device. | When a second device or teammate modifies `databases.json` offline |
| **Backup / snapshot architecture** | SQLite files are in git. Time Machine exists. Turso has point-in-time recovery. | If users lose data from a migration and can't recover from git |
| **PostgreSQL** | Same SQL dialect (SQLite↔Turso) is why the sync layer works. PG would require rewriting ~1,760 lines of sync + dual-dialect testing for every app. Turso handles concurrent writes natively. | Never, unless abandoning local-first entirely |
| **Database-level ACL / RLS** | ACL lives in `resolveAccess()` application layer. Per-database Turso tokens provide physical isolation. Row-level security isn't needed when each team/user gets their own database. | If regulatory compliance requires DB-level enforcement |

---

## Access model (already works)

| Mode | How it works | Status |
|---|---|---|
| **Private** (owner only) | App not published, local SQLite only | ✅ Works |
| **Shared** (team sees same data) | `loginAccess: "team"`, all write same Turso DB | ✅ Works (with Phase 1 sync fix) |
| **Per-user** (each user gets own data) | `isolation: "per-user"`, per-user Turso DB | Phase 4 |
| **Read-only** (view but can't edit) | `link_read` access mode, `resolveAccess` rejects writes | ✅ Works |

---

## File touch list

### Phase 1 (sync fixes)
- `src/gateway/services/TursoSyncBridge.ts` — add pre-push remote check
- `src/gateway/services/tursoSyncBridgeCore.ts` — pull without guards
- `src/gateway/services/CloudJobRunService.ts` — call pull directly after cloud run

### Phase 2 (dbId + registry)
- `src/gateway/services/DatabaseRegistryService.ts` — **new**
- `src/gateway/services/appDataSources.ts` — add `dbId` to types
- `src/gateway/services/AppService.ts` — registry CRUD, safe deletion
- `src/gateway/services/tursoDatabaseNaming.ts` — `dbTursoDatabaseName(dbId)`
- `src/gateway/services/tursoSyncState.ts` — accept dbId
- `src/gateway/services/appRuntime/DbRouter.ts` — resolve by dbId
- `src/gateway/services/appRuntime/TursoDbAdapter.ts` — resolve by dbId
- `scripts/migrate-databases-registry.mjs` — **new** (backfill)

### Phase 3 (standalone)
- `src/core/tools/appJobs.ts` — `create_database` tool
- `src/gateway/services/appDataSources.ts` — allow link without jobId
- `src/core/types/jobEvents.ts` — add `dbId` to db-changed event
- `src/resources/mini-app-sdk/papr-job-events.ts` — `?dbIds=` filter

### Phase 4 (per-user isolation)
- `src/gateway/services/appRuntime/TursoDbAdapter.ts` — per-user naming
- `src/gateway/services/DatabaseRegistryService.ts` — isolation field
- `src/gateway/services/appRuntime/CloudAppHostService.ts` — lazy provision

---

## Test scenarios

1. Team member writes → desktop pushes → team write is NOT overwritten
2. Cloud job completes → desktop pulls results without manual intervention
3. Two apps share one database → unlinking one doesn't destroy data
4. App created with `create_database` → no job exists → app reads/writes normally
5. Database deleted → another device syncs → deleted DB stays deleted (tombstone)
6. Per-user app → User B opens it → sees empty DB, not User A's data
7. Legacy app (no `dbId`) → still works after migration (backfill transparent)
8. Job deleted → database still accessible to other attached apps
9. Offline desktop makes changes → comes online → pulls cloud changes first, then pushes
10. Published app with shared DB → 3 team members write simultaneously → no data loss

---

## Estimated effort

| Phase | Lines (new/changed) | Time |
|---|---|---|
| Phase 1: Sync fixes | ~80 | 1-2 days |
| Phase 2: dbId + Registry | ~340 | 2-3 days |
| Phase 3: Standalone DBs | ~190 | 1-2 days |
| Phase 4: Per-user isolation | ~80 | 1-2 days |
| **Total** | **~690** | **~7-9 days** |

---

## Definition of done

1. A database can exist without any job owning it.
2. Apps and jobs attach/detach without destroying shared data.
3. Team writes and cloud job writes are never silently overwritten.
4. Per-user apps give each user their own database.
5. All 10 test scenarios pass.
6. Existing apps continue working without changes (backward compatible).
7. Agent guidance matches runtime behavior (system prompt, tool descriptions, agent docs).
8. `create_job` with `appIds` auto-links `data-sources.json` at creation time (not only after completion).

---

## Implementation status (2026-07-11)

| Phase | Status | Notes |
|---|---|---|
| Phase 1: Sync fixes | ✅ Done | Pre-push pull via `remoteAheadOfLocal`; cloud run uses `pullAllLinkedSources` |
| Phase 0.5: Quick wins | ✅ Done | Safe unlink (no Turso delete); SSE `dbId` routing; auto-discover gated behind env |
| Phase 2: dbId + Registry | ✅ Done | `DatabaseRegistryService`; path-based `dbId` backfill on `AppService.initialize()` |
| Phase 3: Standalone DBs | ✅ Done | `create_database`, `attach_database`, `delete_database`; `link_app_data_source` accepts `dbId` |
| Phase 4: Per-user isolation | ✅ Done | `isolation` on registry; `resolveTursoShortName` per-user suffix |
| Post-implementation checklist | ⏳ In progress | See below — agent docs, memory repo, bundles, UI |

**Why the plan felt incomplete:** The original doc covered infrastructure phases only. It omitted agent guidance, backward-compat contract, auto-link policy, tests to update, cloud sandbox/memory-repo routing, bundle `dbId` support, and Settings UI — work that must ship with the feature or agents/users break silently.

---

## Phase 0.5: Quick wins (implemented)

These were not in the original 4-phase list but were required before registry work.

| Item | File(s) | Behavior |
|---|---|---|
| Safe unlink | `AppService.onDataSourcesUnlinked` | Unlink clears sync state only; **never** deletes Turso replica while other consumers exist |
| Cloud SSE fix | `resolveDbEventTarget.ts`, `CloudAppHostService` | `publishDbChanged` routes by `jobId` or `dbId` |
| Auto-discover gate | `JobsService`, `AppService` | `autoDiscoverDataSources` only when `PAPR_AUTO_DISCOVER_DATA_SOURCES=true` (off by default) |
| Auto-link on create | `JobsService.createJob` | **Restored** — see policy below |

---

## Auto-link policy (corrected)

**Decision:** Keep auto-link on `create_job` when `appIds` includes a real mini-app (not `__standalone__`).

### Two auto-link hooks (both active)

| When | Method | `allowBaseline` | Purpose |
|---|---|---|---|
| **Job created** | `JobsService.createJob` → `AppService.autoLinkJobToApps` | `true` | App can call `/api/db/*` immediately; empty `data.db` is OK |
| **Job completed** | `JobsService` completion path → `autoLinkJobToApps` | `false` | Re-link after job populates tables (skips if still baseline-only and already linked) |

### What "explicit `create_job` with `appIds` always auto-links" means

**"Explicit"** = the agent (or user) passes `appIds: ["<mini-app-uuid>", ...]` in the `create_job` call. That is an intentional declaration: "this job belongs to these apps."

**"Always auto-links"** = Paprwork does not wait for the agent to call `link_app_data_source`. On save, the gateway:

1. Resolves the job's `$PAPR_HOME/Jobs/{jobId}/data/data.db` path
2. For each `appId` in `appIds` (skipping `__standalone__`):
   - Appends an entry to `$PAPR_HOME/apps/{appId}/data-sources.json`
   - Sets `role: "primary"` if the app had no sources yet
   - Registers the path in `databases.json` (registry backfill on link)

**"Explicit" does NOT mean** auto-discover (scanning app code for sqlite paths). That separate mechanism stays **off** unless `PAPR_AUTO_DISCOVER_DATA_SOURCES=true`.

### Implications for agents and users

| Scenario | What happens |
|---|---|
| `create_job({ appIds: [appId], ... })` | App gets linked immediately; `/api/db/*` works; Turso sync can start |
| `create_job` with only `__standalone__` | No link — job is not tied to any mini-app |
| `create_job` with wrong/missing `appId` | No link to intended app → `/api/db/*` validation fails until manual `link_app_data_source` |
| `create_job` with multiple `appIds` | Links to **all** listed apps; only the first source per app becomes primary |
| Second job for same app | Links as additional source (not primary if one already exists) |
| `create_database` + `attach_database` | **Not** affected — no job involved; agent must attach explicitly |
| Job completes with real tables | Second hook re-runs with `allowBaseline: false` (no-op if already linked at create) |

**Agent obligation:** When building an app + job together, always pass the real `appId` in `create_job`. Forgetting `appIds` is the most common way to get "app can't query database" errors.

**What auto-link does NOT do:**

- Does not create Turso replica by itself (first push/sync does)
- Does not set data contracts / schema validation (still `link_app_data_source` / contracts flow)
- Does not link a standalone registry DB — use `attach_database`
- Does not fix cloud paths that still assume `j-{jobId8}` only (see memory repo section)

### Why auto-link on create was briefly removed (and restored)

A conservative pass disabled create-time linking to avoid linking empty baseline DBs before schema existed. That broke:

- `SystemPrompt.ts` (still says `create_job` auto-links)
- `create_job` tool `_dataSourceLinkReminder` (expects link at create)
- `tests/jobs-service.test.ts` ("createJob auto-links database to linked mini-app")
- Agent workflow: create job → build app → `/api/db/*` fails validation without manual `link_app_data_source`

**`allowBaseline: true` on create** is the right compromise: link immediately so apps work; completion hook still upgrades when real tables exist.

### What we do NOT auto-link

- Jobs with only `appIds: ["__standalone__"]` — no mini-app consumer
- `create_database` + `attach_database` — explicit attach; no job involved
- Standalone DBs shared across apps — agent must call `attach_database` per app

### Agent enforcement layers

1. **Runtime:** `create_job` with mini-app `appIds` → auto-link at create
2. **Tool result:** `_dataSourceLinkReminder` warns if link failed
3. **Validation:** `/api/db/*` fails until `data-sources.json` has a primary source
4. **System prompt:** Documents auto-link + `link_app_data_source({ setPrimary: true })`

---

## Backward compatibility (old apps)

Existing deployments must keep working without migration scripts or manual edits.

| Scenario | Behavior after change |
|---|---|
| `data-sources.json` with `jobId` + `dbPath` only | Unchanged; Turso stays `j-{jobId8}` |
| Registry backfill | On gateway init; dedupes by normalized `dbPath`; adds `dbId` to registry, not retroactively into every `data-sources.json` entry until next link |
| `link_app_data_source({ jobId })` | Still works |
| `$APP_DB` / `$JOB_DB` env injection | Unchanged |
| `primary` in `data-sources.json` | Default alias for `/api/db/*`; not ownership |
| Unlink one app from shared DB | Other apps keep Turso replica |
| Bundled home dashboard / default jobs | `installDefaultJob` paths unchanged |

**Behavioral changes users may notice:**

1. Unlink no longer deletes Turso (safer for shared DBs)
2. Auto-discover off unless `PAPR_AUTO_DISCOVER_DATA_SOURCES=true`
3. New tools: `create_database`, `attach_database`, `delete_database`

---

## Post-implementation checklist

Everything required beyond the 4 infrastructure phases. **Treat unchecked items as release blockers for agent-facing rollout.**

### Agent guidance (required)

| Item | File | Status |
|---|---|---|
| System prompt: auto-link on `create_job` | `src/core/agents/SystemPrompt.ts` | ✅ Matches runtime (verify after restore) |
| System prompt: `create_database` / `attach_database` / `dbId` | `src/core/agents/SystemPrompt.ts` | ✅ Done |
| `create_job` `_dataSourceLinkReminder` | `src/core/tools/appJobs.ts` | ✅ Done |
| `link_app_data_source` description mentions `dbId` | `src/core/tools/appJobs.ts` | ✅ Done |
| `APP_AND_JOBS_GUIDE.md` — standalone DBs, `$APP_DB` vs `$JOB_DB` | `src/resources/agent-docs/APP_AND_JOBS_GUIDE.md` | ✅ Done |
| `agent-job-output-strategy.md` — dbId events | `src/resources/skills/agent-job-output-strategy.md` | ✅ Done |
| Mini-app SDK: `subscribeJobEvents({ dbIds })` | `src/resources/mini-app-sdk/papr-job-events.ts` | ✅ Done |
| Design skill / app creation playbook — link DB before `/api/db/*` | agent skills | ✅ Done |

### Tests (required)

| Test | File | Status |
|---|---|---|
| Independent databases (registry, tools, events) | `tests/independent-databases.test.ts` | ✅ Done |
| SSE `?dbIds=` filter | `tests/job-events-sse-filter.test.ts` | ✅ Done |
| `createJob` auto-links on create | `tests/jobs-service.test.ts` | ✅ Restored in JobsService |
| Turso sync status dirty fingerprint | `tests/turso-sync-status.test.ts` | ✅ Done |
| E2E: naming + registry checks | `scripts/test-independent-databases-e2e.mjs` | ✅ Done (automated) |
| E2E: team write not overwritten | manual / script | ⏳ Manual with live Turso |
| E2E: `create_database` → app reads without job | manual / script | ⏳ Manual with gateway |

### Cloud / memory repo consistency (required — not optional)

The memory server's **`POST /v1/cloud/databases/token`** endpoint is already generic: it accepts any valid short name (`j-de1a89d8`, `d-a1b2c3d4`, `j-de1a89d8-u-12345678`). **No change needed there.**

The problem was **callers that hardcode `j-{jobId8}`** only. **Fixed (2026-07-11):** shared `turso_database_naming.py` in memory, `resolveTursoDatabaseNameForSource` in paprwork, `appBackendDatabase.ts` dbId support, `databaseShortName` in cloud agent prepare payload.

#### Naming contract (both repos must match)

| Source type | Turso short name | Per-user (`isolation: "per-user"`) |
|---|---|---|
| Job-owned `data.db` | `j-{jobId8}` | `{base}-u-{userId8}` |
| Standalone registry DB | `d-{dbId8}` | `{base}-u-{userId8}` |
| Legacy | `data` | (read-only migration) |

**paprwork-v2 reference:** `src/gateway/services/tursoDatabaseNaming.ts` (`jobTursoDatabaseName`, `dbTursoDatabaseName`, `resolveTursoShortName`)

**memory repo today:** only `job_turso_short_name()` in `services/cloud_workspace_repo_service.py` — **no `d-` or per-user helpers**.

#### memory repo — files to update

| File | Current behavior | Required change |
|---|---|---|
| `services/cloud_workspace_repo_service.py` | `job_turso_short_name` only | ✅ Uses `turso_database_naming.py` |
| `services/cloud_job_runner_service.py` | `_resolve_job_env` → `job_turso_short_name(job_id)` | ✅ Uses shared naming module |
| `services/cloud_agent_run_prepare.py` | `_resolve_turso` → job id only | ✅ Returns `databaseShortName` |
| `services/turso_database_naming.py` | — | ✅ **NEW** — `db_turso_short_name`, `resolve_turso_short_name` |
| `tests/test_turso_database_naming.py` | — | ✅ **NEW** |
| `models/cloud_models.py` | Docs/examples mention `j-de1a89d8` only | Document `d-` and per-user suffix in field descriptions |
| `services/turso_service.py` | `validate_database_short_name` | ✅ Already accepts `d-*` and `-u-*` suffixes (max 22 chars) |
| `services/cloud_app_runtime_service.py` | `runtime_db_token(database=...)` | ✅ Pass-through — works if paprwork sends correct name |
| `tests/test_cloud_app_runtime_routes.py` | Job-centric fixtures | Add tests for `d-{dbId8}` token + per-user name |
| `tests/test_cloud_job_runner_service.py` | Job Turso only | Test push/pull with explicit `database` param |

#### paprwork-v2 — cloud paths still job-centric (fix with memory)

| File | Gap |
|---|---|
| `src/gateway/services/appRuntime/appBackendDatabase.ts` | Returns `null` if `primary.jobId` missing | ✅ Fixed — uses `resolveTursoDatabaseNameForSource` |
| `src/gateway/services/cloudAgentGateway/types.ts` | `turso.jobId` only | ✅ Added `databaseShortName` |
| `src/gateway/services/cloudAgentGateway/cloudAgentRunContext.ts` | Bookend sync assumes job path + `j-{jobId8}` | ✅ Syncs all `tursoSources` (job + APP_DB) |
| `memory/services/cloud_agent_run_prepare.py` | Always provisions `j-{jobId8}` for cloud agent runs | ✅ `linkedSources` + `tursoSources` + primary |

#### Target cloud prepare payload (cross-repo contract)

Memory `prepare_cloud_agent_run_context` should accept linked sources from paprwork, not derive Turso name from `jobId` alone:

```json
{
  "jobId": "...",
  "linkedSources": [
    { "alias": "CRM", "dbPath": "...", "jobId": "...", "dbId": "db-...", "tursoShortName": "j-de1a89d8", "isolation": "shared" }
  ],
  "primaryTursoShortName": "j-de1a89d8"
}
```

Cloud agent gateway bookends (`syncJobTursoBookends.ts`) should sync **primary linked source** by resolved short name, not assume job folder is the only DB.

#### Verification checklist (memory + paprwork)

1. Desktop: `create_database` → `attach_database` → Turso push uses `d-{dbId8}` token from memory ✅/❌
2. Cloud app host: team member reads/writes standalone DB via `TursoDbAdapter` ✅ (DbRouter fixed) / app backend env ❌ (`appBackendDatabase.ts`)
3. Cloud job run: job with `appIds` still uses `j-{jobId8}` ✅ / standalone DB job ❌
4. Per-user app: User B gets `j-xxx-u-{userB8}` not User A's data ⏳ (naming in paprwork; memory must mint same name)
5. Cross-repo unit test: same `dbId` → same `d-{hex}` in TS and Python

**Status:** ⏳ Blocker for standalone DBs in cloud; job-owned DBs (`j-`) continue to work.

### Bundles & defaults

| Item | Status |
|---|---|
| `scripts/migrate-databases-registry.mjs` standalone script | ✅ `npm run migrate:databases-registry` |
| Bundle export/import preserves `dbId`, resolves paths on import | `BundleService.ts` | ✅ Done |
| Default home dashboard `data-sources.json` uses known job IDs | ✅ Works via job-based link |

### UI / settings (optional for v1)

| Item | Status |
|---|---|
| Settings: list registered databases from `databases.json` | ✅ `DatabasesTab` + `GET /api/databases` |
| App editor: pick DB from registry (not only jobs) | ✅ `MiniAppDataSourcesPanel` + `POST /api/apps/:appId/link-database` |
| Sync chip copy for dirty Turso state | ✅ Done (`tursoSyncStatus.ts`) |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PAPR_AUTO_DISCOVER_DATA_SOURCES` | unset (off) | Scan job folders for sqlite and auto-link |

---

## Registry design notes (implementation vs original plan)

**`dbId` generation:** Implemented as stable hash from **normalized `dbPath`**, not `hash(jobId + alias)`. Same physical file → same `dbId` across apps.

**`DatabaseRecord` fields (implemented):**

```ts
interface DatabaseRecord {
  dbId: string;
  name: string;
  localPath: string;
  tursoShortName?: string;   // j-{jobId8} legacy or d-{dbId8} standalone
  ownerJobId?: string;       // legacy job that created the file
  state: "active" | "deleted";
  deletedAt?: string;
  createdAt: string;
  isolation?: "shared" | "per-user";
}
```

**Turso naming:**

- Job-owned: `j-{jobId8}` (unchanged)
- Standalone: `d-{dbId8}`
- Per-user: `{tursoShortName}-u-{userId8}`

---

## Agent workflow (target)

```
# Path A — job owns the DB (most common)
create_job({ name, appIds: [appId], type: "python", command: "..." })
  → auto-links data-sources.json (allowBaseline)
  → job writes to $JOB_DB; app reads via $APP_DB (same file when primary)

# Path B — shared DB without a job
create_database({ name: "CRM" })
attach_database({ appId, dbId, setPrimary: true })
create_job({ name: "CRM Sync", appIds: [appId], ... })  // optional; uses $JOB_DB scratch

# Path C — re-link / multi-app
link_app_data_source({ appId, jobId })   // legacy
link_app_data_source({ appId, dbId })    // preferred for registry DBs
```

---

## Revised definition of done (full)

1. Infrastructure phases 1–4 complete ✅
2. Auto-link on `create_job` restored ✅
3. All post-implementation checklist items for **agent guidance** complete ✅
4. All 10 test scenarios pass (including automated tests) ⏳ (manual Turso E2E remain)
5. **memory repo + paprwork cloud paths use same Turso naming** (`j-`, `d-`, per-user) ✅ (shared module + types)
6. `appBackendDatabase.ts` resolves primary by registry/`dbId`, not only `jobId` ✅
7. No silent mismatch between system prompt and runtime behavior ✅

---

**This file is living documentation. Update checklist status as items ship.**
