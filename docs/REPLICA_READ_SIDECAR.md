# Replica read sidecar (design)

**Status:** Design only — **not** Turso best practice; last-resort if scheduling fixes are insufficient.  
**Goal:** DbQueryPool-like read throughput for mini-apps **without** a second `@tursodatabase/sync` engine on the same `data.db`.

## Turso-aligned model (what “fast reads” actually means)

With embedded replicas (libsql / `@tursodatabase/sync`), **the fast path is already local**:

- **Reads** hit the **local SQLite file** (last synced state) — no round trip to Turso per SELECT.
- **Sync** (`pull` / `push`) happens on an interval or after writes — **not** before every read.
- **Authority** stays on Turso primary; the local file is a **cache of replicated state**, not a second product-level replica you maintain by hand.

So industry best practice is **not** “copy the replica again.” It is:

1. **Read locally** without `pull` on the hot path (Papr: `pullBeforeRead: false` for mini-apps).
2. **Sync in the background** without blocking UI reads (scheduling / yield / coalesce push).
3. **Batch work** (fewer trips into the sync worker — `queryBatch`, app `/api/db/batch`).
4. **When local is wedged or stale and you’re online**, read **Turso primary over HTTP** (Papr: timeout/degraded fallback). When online, mini-app reads **race** local replica and primary in parallel (`raceFirstSuccessful` in `DbRouter`) so a stuck sync queue does not add a full local timeout before cloud can answer.
5. **First paint (`MINI_APP_LOAD_WINDOW_MS`, default 20s):** after `app:get` or `/api/db/*`, reads use **local replica only** (no primary race / timeout fallback) so cloud and replica do not fight during load. Background **replica push** is **deferred** while the interactive hot path is busy (`TURSO_PUSH_DEFER_WHILE_INTERACTIVE`, manual push exempt). **App-open cloud→local reconcile** (`TursoPullScheduler`) waits for the first successful mini-app `/api/db/query` or batch read (`notifyMiniAppFirstDataPaint`), then debounces 3s — or falls back after `TURSO_PULL_FIRST_PAINT_MAX_WAIT_MS` (default 120s) for apps with no DB reads.

**Replica read phase timings:** slow replica reads log `[ReplicaReadPhases]` with a per-stage breakdown (`httpQueueMs`, `gatewayPathQueueMs`, `openSpecMs`, `ipcRoundTripMs`, `workerQueueMs`, `workerExecMs`, `unaccountedMs`). Set `REPLICA_READ_TRACE=1` to log every read. Inspect recent traces: `GET /api/debug/replica-read-phases` (plus worker stderr ring: `/api/debug/turso-worker-timings`).
5. **Cloud / server runtimes** query Turso directly (no embedded file) — Papr cloud host already does this.

Item 5 below is only if we still serialize reads behind long `push`/`pull` jobs **inside our worker** despite the above — i.e. a Papr queueing problem, not something Turso docs tell you to solve with snapshots.

## Problem

Plan A replicas use **one sync engine handle per `data.db`**. All reads and sync (pull/push) share **one serial queue per path**. That is correct for Turso sync integrity but caps read latency when:

- Background push/pull holds the lane.
- A screen fires many SELECTs (even via `/api/db/batch` with `queryBatch`, CPU work is cheap but queue wait is not).

`DbQueryPool` works for **legacy local** SQLite because those files are **not** owned by the sync engine.

## Principle

> **One sync writer per replica file. Many readers only if they do not open a second sync engine or fight the WAL.**

A read sidecar is a **read-only SQLite view** of data that is **fed by** the replica, not a second replica client.

## Options (ranked)

### A. Turso primary for read-heavy UI (already partial)

- **What:** `DbRouter` already falls back to Turso HTTP on timeout/degraded.
- **Pros:** No new local process; always fresh when online.
- **Cons:** Network latency; cost; offline broken.
- **Use when:** Interactive read blocked on local queue.

### B. Snapshot file (recommended long-term)

1. After successful **push** or on idle timer (path quiesced ≥ N minutes, no interactive depth):
2. Gateway asks sync worker to **export** or **checkpoint into** a read-only file, e.g. `data.db.readonly` or `data.db.snapshot`.
3. Mini-app SELECTs on a flag `readPreference: sidecar` route to **`DbQueryPool`** on the snapshot path only.
4. **Invalidation:** Bump snapshot generation on every local mutation + successful push; readers check generation (cheap stat) before query.

**Pros:** True parallel reads (pool threads); sync lane unchanged.  
**Cons:** Staleness bound (seconds–minutes); disk space; export must be Turso-safe (no raw checkpoint that wedges sidecars — coordinate with engine team / use approved API).

### C. WAL-mode readonly attach (risky)

- Attach `-wal` from a readonly connection while sync engine open.
- **Rejected for Plan A** unless Turso documents it — same class of bug as job `sqlite3` + sync (`replicaDbJobQuiesce.ts`).

## Invariants (must not break)

1. At most **one** `@tursodatabase/sync` `connect()` per `data.db` path.
2. No `better-sqlite3` / job sqlite on the **live** replica path while sync handle open.
3. Sidecar file is **never written** by app jobs — read pool only.
4. Schema drift: sidecar refresh must follow replica schema version or reads fail closed → primary fallback.

## Implementation phases

| Phase | Deliverable | Risk |
|-------|-------------|------|
| **0** | `queryBatch` + batch grouping (done) | Low |
| **1** | Metrics: `queueMs` / `execMs` per batch; alert when queue dominates | Low |
| **2** | Explicit `GET /api/db/query?consistency=primary` for apps that opt in | Low |
| **3** | Snapshot builder in sync worker (new op `exportReadSnapshot`) | Medium |
| **4** | `DbRouter` route SELECT → pool on snapshot when fresh | Medium |
| **5** | Auto-invalidate on write + push; TTL cap | Medium |

## API sketch (future)

```typescript
// Gateway internal
type ReadRoute =
  | { kind: "replica-sync" }           // default, strongest local consistency
  | { kind: "snapshot"; maxStaleMs: number }
  | { kind: "primary" };              // online only

// Mini-app optional header or query param (local preview + cloud host parity TBD)
```

## Success criteria

- P95 mini-app read **queueMs** drops ≥ 50% on contested paths under sync load.
- No increase in sidecar wedge / crash streak (`MAX_CONSECUTIVE_PATH_CRASHES`).
- Staleness documented: e.g. “snapshot may lag up to 30s behind primary.”

## Related

- `docs/SYNC_TURSO_REPLICA_PLAN.md` — Plan A authority model
- `src/gateway/services/tursoReplica/replicaDbJobQuiesce.ts` — why dual open fails
- `docs/GATEWAY_PLANES_AND_PHASES.md` — Phase C background offload (orthogonal)
