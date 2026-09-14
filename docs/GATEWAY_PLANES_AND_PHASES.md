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
| `GATEWAY_BACKGROUND_PROCESS` | on (off in tests) | Spawn background child for delegated vault tasks |
| `GATEWAY_BG_MAX_CONCURRENCY` | `clamp(1, cpus−1, 4)` | Parallel coalesced background tasks |
| `DB_QUERY_POOL_SIZE` | device-derived | SQLite worker threads |
| `CODE_INDEX_IO_POOL_SIZE` | device-derived | Code index read workers |

### Verification

```bash
npx vitest run tests/gateway-background-concurrency.test.ts tests/gateway-background-work.test.ts --project unit-backend
npm run build:gateway && npm run test:gateway-background-phases
```

## Observability (gateway perf — not Amplitude)

Product telemetry (opt-in) goes to Amplitude via `TelemetryClient` / `paprwork_*` events. **Sub-second hot-path timing stays local:**

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
