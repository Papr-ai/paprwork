# Gateway planes and rollout phases

## Planes (target topology)

| Plane | Process | Role |
|-------|---------|------|
| **Interactive** | Gateway Node | WebSocket, agent orchestration, mini-app HTTP routing, health |
| **Data** | Same gateway + worker threads / Turso child | SQLite pool, replica sync — not a separate Node unless profiling requires it |
| **Background** | Optional extra Node (Phase C) | Vault batches, code index, cloud git flush |

The OS schedules processes on available cores. The app does **not** pin cores in Phase A–B.

## Startup vs chat readiness

**Must be ready for chat (main / IPC, fast):**

- OAuth and API keys (`CustomKeysService` via Electron)
- Papr plan / subscription (`papr.getPlanSummary` in renderer)

**Deferred until interactive quiet (gateway):**

- Vault full push/pull (`VaultSyncService`)
- Code index batches
- `papr:resume-cloud` heavy vault sync (scheduled, coalesced)

## Phase A (implemented)

- `gatewayBackgroundWork.ts` — yield to interactive hot path; coalesced tasks
- `papr:resume-cloud` — schedules vault sync; WS handler returns immediately
- Vault push/full sync — yield before heavy work
- Code index batches — defer when interactive busy or event-loop lag high
- Billing UI — skip `papr:resume-cloud` when gateway `degraded`; 120s min interval

### Env vars

| Variable | Default | Meaning |
|----------|---------|---------|
| `GATEWAY_BG_QUIET_MS` | 1500 | Sustained idle before background work |
| `GATEWAY_BG_MAX_WAIT_MS` | 120000 | Start background anyway after this wait |
| `GATEWAY_BG_DEFER_EVENT_LOOP_MS` | 1500 | Defer index when mean event-loop lag ≥ this |
| `TURSO_PUSH_YIELD_QUIET_MS` | 1500 | Wait for interactive quiet before **starting** replica push |
| `TURSO_PUSH_YIELD_MAX_WAIT_MS` | 60000 | Start push anyway after this wait |
| `LOCAL_DB_READ_CACHE_TTL_MS` | 8000 | Loopback `/api/db/query` completed-read cache |
| `REPLICA_MINI_APP_READ_TIMEOUT_MS` | 5000 | First replica read attempt timeout |
| `REPLICA_MINI_APP_READ_RETRY_TIMEOUT_MS` | 15000 | Local replica retry after timeout |

## Phase B (implemented)

- `CodeIndexIoPool` + `code-index-io-worker.ts` — file read + SHA-256 off main thread
- `SmartCodeIndexManager` — one read per queued file; summary + raw indexer reuse snapshot
- `CodeIndexTracker.needsIndexingWithHash` — skip redundant main-thread reads
- Env: `CODE_INDEX_IO_POOL_SIZE` (default 2), `CODE_INDEX_IO_MAX_BYTES` (default 2_000_000)
- Papr Memory / LLM summary calls still run on gateway main (async I/O); sync `readFileSync` removed from batch hot path

## Phase C (implemented)

- `GatewayBackgroundWorkerClient` + `gatewayBackgroundWorkerEntry.ts` — optional Node child (IPC)
- Coalesced vault tasks (`papr:resume-cloud`, `vault:workspace-switch`) push HTTP in child; keychain + reconcile stay in gateway parent
- Disable with `GATEWAY_BACKGROUND_PROCESS=0` (default on; off under `VITEST`)

## Phase D (implemented)

- `gatewayBackgroundConcurrency.ts` — `GATEWAY_BG_MAX_CONCURRENCY` or `clamp(1, cpus−1, 4)`
- `DbQueryPool` / `CodeIndexIoPool` default sizes follow the same policy (`DB_QUERY_POOL_SIZE`, `CODE_INDEX_IO_POOL_SIZE` override)
- Coalesced background tasks respect max concurrent slots

### Env vars (Phase C/D)

| Variable | Default | Meaning |
|----------|---------|---------|
| `GATEWAY_BACKGROUND_PROCESS` | **on** (set `0`/`false`/`off` to disable; off in tests) | Spawn background child for delegated vault tasks |
| `GATEWAY_BG_SLOW_TELEMETRY_MS` | 10000 | Emit opt-in `paprwork_slow_operation` when a coalesced background task exceeds this duration |
| `GATEWAY_BG_MAX_CONCURRENCY` | `clamp(1, cpus−1, 4)` | Parallel coalesced background tasks |
| `DB_QUERY_POOL_SIZE` | device-derived | SQLite worker threads |
| `CODE_INDEX_IO_POOL_SIZE` | device-derived | Code index read workers |

### Verification

```bash
npx vitest run tests/gateway-background-concurrency.test.ts tests/gateway-background-work.test.ts --project unit-backend
npm run build:gateway && npm run test:gateway-background-phases
```

## Observability (gateway perf — not Amplitude)

Product telemetry (opt-in) goes to Amplitude via `TelemetryClient` / `paprwork_*` events. Coalesced background tasks ≥ `GATEWAY_BG_SLOW_TELEMETRY_MS` (default 10s) emit `paprwork_slow_operation` with `operation_name`, `duration_ms`, `threshold_ms` only. **Sub-second hot-path timing stays local:**

| Work | How to see duration |
|------|---------------------|
| Coalesced background tasks (`papr:resume-cloud`, `vault:*`, `system:resume-jobs`, `cloud-sync:reconcile:*`) | `[GatewayBackground] {taskKey} finished in {ms}ms` + `GET http://127.0.0.1:18789/api/debug/gateway-background` |
| `/api/sync/items` phases | `[SyncItems] {total}ms … reconcileScheduled=… turso=… appSyncV3=…` when slow (`SYNC_ITEMS_SLOW_MS`, default 500) or `SYNC_ITEMS_TRACE=1` |
| Per-app sync poll (cached) | `[SyncItems] … responseCached=true` (full payload cache, `SYNC_ITEMS_APP_CACHE_TTL_MS`, default 20s) |
| Replica reads | `[ReplicaReadPhases]` slow-only; `REPLICA_READ_TRACE=1`; `GET /api/debug/replica-read-phases` |
| Turso worker IPC | `GET /api/debug/turso-worker-timings` |
| Job scheduler tick | `[JobsScheduler]` phase timer (always logged on tick) |
| Code index batch | `[CodeIndexing] Deferring batch…` / `Processing batch: N files` (defer = waiting for interactive quiet) |
| Event-loop pressure | `[GatewayEventLoop]` when lag exceeds threshold |

```bash
# Examples (gateway must be running)
curl -s http://127.0.0.1:18789/api/debug/gateway-background | jq
curl -s 'http://127.0.0.1:18789/api/sync/items?appId=YOUR_APP_ID'  # compare first vs second call within 20s
```

**Packaged app / support:** Settings → Privacy → **Copy gateway diagnostics** (Electron clipboard + 8s per-endpoint timeout; includes `/health` and workspace switch status). Home paths redacted; not uploaded automatically.

### Workspace switch (what runs when)

1. **Fast path:** cancel streams, raise readiness barrier, swap `PAPR_HOME` pointer, phased reinit (core → artifacts → services), release barrier.
2. **Background (coalesced):** `vault:workspace-switch` → full vault push/pull; cloud git sync deferred **60s**; `/health` reports `switching` for up to **90s** after completion so the supervisor does not SIGKILL mid-vault.
3. **UI billing:** `papr:resume-cloud` is rate-limited to **120s** and now **skips** if `vault:workspace-switch` is already in flight (avoids duplicate 90s vault work).

### Vault / memory.papr.ai degradation

- Generic `GET /health` on memory can be **200** while `POST /v1/cloud/vault/sync` returns **500** (platform bug or org-specific vault state).
- After a **500**, gateway pauses vault HTTP with exponential backoff (30s → 15m cap). Override push wait with `VAULT_PUSH_TIMEOUT_MS` (default **45s**, was 120s).
