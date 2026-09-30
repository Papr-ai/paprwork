# Cloud DB Performance Optimization Plan

**Created:** 2026-08-21  
**Context:** Production `/api/db/write` p50 **4.1s** (access 0ms, config **1.5s**, tursoWrite **2.5s**). Memory workspace log server-side work is only **~550ms** — most latency is duplicate auth + GitHub config fetches.

**Goal:** Restore V2-like server→Turso latency (**&lt;1.5s p50** write, **&lt;500ms p50** read) while keeping Sync V3 workspace log as the cross-device authority.

**Non-goals:**
- Browser → Turso direct (tokens stay server-side)
- Async materialize before row exists on Turso (UX/sync risk)
- GCS shared cache (Phase 4 — future)

---

## Baseline (prod, n=185, last 7 days)

| Phase | p50 | p90 |
|-------|-----|-----|
| accessMs | 0 ms | 0 ms |
| configMs | 1,492 ms | 3,470 ms |
| tursoWriteMs | 2,541 ms | 3,904 ms |
| **totalMs** | **4,104 ms** | **7,203 ms** |

Memory append breakdown (server-side): oplog ~400ms + materialize ~130ms.

---

## Architecture (unchanged)

```
READS:  Browser → cloud app host → [access + config] → db token → Turso
WRITES: Browser → cloud app host → [access + config] → memory workspace log → Turso
DESKTOP: Local SQLite → workspace log ship → memory → Turso → desktop pull/replay
```

Optimizations reduce bracketed overhead, not the workspace log contract.

---

## Phase 1 — Quick wins (paprwork-v2 only, ~1–2 days)

### 1.1 Access cache TTL → 30 min + explicit bust ✅

**Changes (`paprwork-v2`):**
- `cloudAppHostCache.ts`: `ACCESS_TTL_MS = 30 * 60 * 1000`
- `invalidateRepoCacheForPublishedApp` / `invalidateRepoCacheForNamespace` also bust access cache
- Wired via existing `/internal/app-revision-updated` and repo-committed handlers

### 1.2 Parallel repo-file fetches ✅

- `loadAppDataSourcesConfig()` in `cloudDatabaseRegistry.ts` — `Promise.all` for all 3 JSON files
- `hydrateCloudDatabaseRegistry` parallelizes linked + databases registry

### 1.3 Skip redundant `loadDataSources` per request ✅

- `handleQuery`: single `loadDataSources` call reused for version gate + query

### 1.4 Query path timing logs ✅

- `handleQuery` / `handleBatchQuery`: `[CloudAppHost] /api/db/query timing ...` (disable with `CLOUD_DB_QUERY_TIMING=0`)

---

### 1.5 Already done ✅

- **db-token cache** (50 min) — `memoryRuntimeClient.ts`
- **resolveSource** no Turso open on write — `TursoDbAdapter.ts` rev 00043
- **Enriched auth** from `resolveDbAppContext` — rev 00043

---

## Phase 2 — Memory fast path on workspace log (~1–2 days, **memory** deploy) ✅

### 2.1 Trust cloud app host on append ✅

**Changes (`memory`):**
- `WorkspaceLogRuntimeFields`: optional `orgId`, `ownerUserId`, `appId` attestation
- `resolve_workspace_log_owner_scope`: fast path when host key + attestation present — skips `_resolve_runtime_access` + `resolve_allowed_turso_names_for_app`
- Append + append-batch routes pass attestation fields through

**Changes (`paprwork-v2`):**
- `WorkspaceLogHostScope` type + `appendRuntimeWorkspaceLogEntry/Batch` send attestation
- `TursoDbAdapter` passes scope from validated access context on all workspace-log writes

**Security:** Host key server-side only; host already validated access + replica locally before append.

---

## Phase 3 — Config in Mongo + cache (~3–5 days, **memory** + **paprwork-v2**)

### 3.1 Extend Phase 4.6 metadata to per-app DB config

**Today:**
| File | Read path |
|------|-----------|
| `data/databases.json` | Mongo first, git fallback ✅ (code); prod dogfood sign-off pending |
| `data-sources.json` | GitHub only ❌ |
| `linked-databases.json` | GitHub only ❌ |

**Changes (`memory`):**
- Mongo collection `app_db_config` (or extend existing): `{ appId, userKey, dataSources, linkedDatabases, updatedAt, commitSha }`
- `PUT /v1/cloud/metadata/app-db-config` (dual-write target)
- `load_app_db_config_mongo(appId)` used by:
  - `cloud_linked_sources.py` (allowlist + repo-file)
  - New bundled read path (3.2)
- In-process cache on memory: TTL 10 min, bust on metadata PUT or app-repo commit webhook

**Changes (`paprwork-v2`):**
- `MetadataRegistryClient.ts`: dual-write on sync/publish when `data-sources.json` or `linked-databases.json` changes (mirror databases registry)
- Hook: writer commit, `prepareAppsForCloud`, `flushAppNow` success path

**Git:** Remains in app repo for portability; runtime reads Mongo first.

**Expected savings:** configMs p50 **→ ~10–50ms** (Mongo + memory cache hit).

---

### 3.2 Bundled config endpoint (optional if 3.1 complete)

**Changes (`memory`):**
- `POST /v1/cloud/apps/runtime/app-db-config` → `{ dataSources, linkedDatabases, databasesRegistry }` one round trip

**Changes (`paprwork-v2`):**
- Replace 3× `fetchRuntimeRepoFile` in `loadDataSources` + hydrate with single call when Mongo miss

Use if Mongo backfill is incomplete; otherwise 3.1 alone may suffice.

---

### 3.3 Host-side config cache keyed by app revision

**Changes (`paprwork-v2`):**
- Extend `repoFileCache` or add `appDbConfigCache` keyed by `(namespaceId, slug, revision)`
- Bust on `invalidateRepoCacheForPublishedApp` (already wired)
- Optionally fetch bundled config once per revision on first db op after app load

---

## Phase 4 — Turso pipeline collapse (~1 day, **memory**)

### 4.1 Single pipeline: oplog seq + materialize + mark

**Problem:** Two Turso HTTP pipelines per append (oplog, then materialize).

**Changes (`memory`):**
- `workspace_log_service.append_workspace_log_entry`: one `_turso_pipeline` with ordered statements:
  1. INSERT oplog … RETURNING seq (or fallback path)
  2. Execute row SQL from payload
  3. INSERT materialized mark
- Keep timing fields; expect materializePipelineMs ≈ 0, oplogPipelineMs absorbs work

**Safety:** Same SQL order as today; one transaction semantics per Turso pipeline batch.

**Expected savings:** ~100–200ms per append.

---

## Phase 5 — App & docs (~0.5 day)

### 5.1 Write-batch guidance

**Problem:** Apps firing N single writes pay N× round trips.

**Changes:**
- Agent system prompt + `APP_AND_JOBS_GUIDE.md`: prefer `/api/db/write-batch` for bulk inserts
- No server change required (endpoint exists)

---

## Phase 6 — Future (explicitly deferred)

| Item | Notes |
|------|-------|
| **GCS shared repo/config cache** | Cross-instance warmth; small cost; do after Phase 3 metrics |
| **Async materialize** | Rejected — row must exist before success |
| **Mongo prod sign-off for databases.json** | Complete Phase 4.6 dogfood checklist |
| **Immutable release pins for cloud-app-host** | SYNC_V3 Phase 5 |

---

## Deploy order

1. **paprwork-v2 Phase 1** → deploy cloud-app-host (low risk)
2. **memory Phase 2** (fast path) → deploy memory server
3. **memory + paprwork Phase 3** (Mongo app db config) → deploy both
4. **memory Phase 4** (pipeline collapse) → deploy memory server
5. Phase 5 docs anytime

---

## Verification

### Automated
- `npm run test:cloud-app-host` (existing)
- `node scripts/test-sync-v3-write-optimizations-e2e.mjs`
- New: unit tests for access cache bust, parallel hydrate, fast-path append mock

### Production metrics (Cloud Run logs)
```
[CloudAppHost] /api/db/write timing ...
[CloudAppHost] /api/db/query timing ...
[WorkspaceLog] append ... timing credentialsMs=... oplogPipelineMs=...
```

**Targets after Phase 1+2:**
| Metric | Before p50 | Target p50 |
|--------|------------|------------|
| configMs | 1,492 ms | &lt;900 ms |
| tursoWriteMs | 2,541 ms | &lt;1,000 ms |
| totalMs | 4,104 ms | &lt;1,500 ms |

**Targets after Phase 3:**
| Metric | Target p50 |
|--------|------------|
| configMs | &lt;50 ms |
| totalMs (write) | &lt;800 ms |

---

## File touch list

### paprwork-v2
- `src/gateway/services/appRuntime/cloudAppHostCache.ts`
- `src/gateway/services/appRuntime/CloudAppHostService.ts`
- `src/gateway/services/appRuntime/cloudDatabaseRegistry.ts`
- `src/gateway/services/appRuntime/memoryRuntimeClient.ts`
- `src/gateway/services/appRuntime/TursoDbAdapter.ts`
- `src/gateway/services/syncV3/MetadataRegistryClient.ts`
- `tests/cloud-app-host-cache.test.ts`
- `docs/ARCHITECTURE_CONVERSATION_SYNTHESIS.md` (link this plan)

### memory
- `services/cloud_app_runtime_service.py`
- `services/cloud_linked_sources.py`
- `services/workspace_log_service.py`
- `services/namespace_metadata_registry_service.py`
- `routers/v1/cloud_metadata_routes.py`
- `routers/v1/workspace_log_routes.py`
- `tests/test_workspace_log_routes.py`
- `tests/test_cloud_linked_sources_allowlist.py`

---

## Related docs

- [SYNC_V3_IMPLEMENTATION_PLAN.md](./SYNC_V3_IMPLEMENTATION_PLAN.md) — Phase 4.6 Mongo metadata
- [ARCHITECTURE_CONVERSATION_SYNTHESIS.md](./ARCHITECTURE_CONVERSATION_SYNTHESIS.md) — caller/publisher + perf context
- [SYNC_CONTRACT.md](./SYNC_CONTRACT.md) — workspace log authority (unchanged)
