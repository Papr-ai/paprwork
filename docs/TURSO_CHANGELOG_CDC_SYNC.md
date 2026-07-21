# Turso Changelog CDC Sync

**Added:** 2026-07-09  
**Status:** Implemented

## Problem

App-linked job SQLite (`~/Papr/Jobs/{id}/data/data.db`) syncs to Turso for cloud mini-apps. The previous sync path was **not true row-level delta**:

1. **Fingerprints** skipped unchanged tables (good).
2. Tables **≤ 2,000 rows with a PK** used incremental upsert (good for small tables).
3. Tables **> 2,000 rows** fell back to `DROP TABLE` + re-insert **all rows** on every push (expensive at scale).
4. **Every push** still read the **entire local table** when a table was considered changed.

For a 1M-row scrape job, updating one row could rewrite the full table on Turso and read 1M rows locally.

## Solution

**Changelog CDC** via SQLite triggers:

```
Any writer (Python job, Node, bash, desktop mini-app)
        ↓
  AFTER INSERT/UPDATE/DELETE triggers
        ↓
     _papr_sync_log  (table_name, op, row_pk JSON)
        ↓
  Delta push: fetch only changed rows by PK → upsert/delete on Turso
  Delta pull: read remote log → apply rows to local (muted, no echo)
```

Works without job code changes — triggers capture all SQL writers automatically.

## Infrastructure tables

| Table | Purpose |
|-------|---------|
| `_papr_sync_log` | Changelog: `id`, `table_name`, `op`, `row_pk`, `changed_at` |
| `_papr_sync_mute` | `depth` counter — suppresses triggers during sync apply |
| `_papr_sync_meta` | Remote version counter for cheap “unchanged?” checks |

Triggers are named `_papr_tr_{table}_ai|au|ad` (after insert/update/delete).

## Sync modes

| Mode | When | Behavior |
|------|------|----------|
| `bootstrap` | Remote has no user tables | Full snapshot once, install remote triggers, prune local log |
| `delta` | Pending `_papr_sync_log` entries | Push/pull only changed rows by primary key |
| `snapshot_fallback` | Table has **no PRIMARY KEY** | Full table copy (legacy path) |
| `full` | Remote has no changelog yet | Full pull of all remote tables |

**Requirement:** Delta sync requires a `PRIMARY KEY` on syncable tables. Tables without one still use snapshot fallback.

## Push flow (desktop → Turso)

1. Open local `data.db`, install triggers if missing (`ensureLocalTableSyncTriggers`).
2. Read pending entries: `readSyncLogSince(lastPushedLogId)`.
3. If remote empty → **bootstrap** (full snapshot).
4. Else if pending entries → **delta push** (`pushDeltaToRemote`), mirror log to remote, prune local log through `lastPushedLogId`.
5. Else if fingerprint changed but no log (legacy / no-PK tables) → **snapshot_fallback**.

## Pull flow (Turso → desktop)

1. Read remote log since `lastPulledLogId` (checked **before** version skip).
2. If entries exist → **delta pull** inside `withSyncMutedAsync` (no local echo).
3. Else if `_papr_sync_meta` version unchanged → skip (`remote_unchanged`).
4. Else → **full pull** (legacy).

## State persistence

`~/Papr/data/.turso-sync-state.json` per linked job:

```json
{
  "jobs": {
    "job-uuid": {
      "dbPath": "/Users/.../data.db",
      "lastPushAt": "2026-07-09T...",
      "tableFingerprints": { "records": "abc123..." },
      "lastSeenRemoteVersion": 12,
      "lastPushedLogId": 4501,
      "lastPulledLogId": 89
    }
  }
}
```

## Cloud mini-app writes

`TursoDbAdapter` installs remote CDC triggers on first write (`ensureRemoteChangeLogReady`). Cloud SQL writes fire remote triggers → `_papr_sync_log` on Turso → desktop delta pull.

Also bumps `_papr_sync_meta` so version-checked pulls see the change.

## Mute guard (echo prevention)

When applying remote changes locally:

```typescript
await withSyncMutedAsync(localDb, async () => {
  await applyRemoteSyncLogToLocal(localDb, remote, remoteEntries);
});
```

`depth > 0` disables triggers — sync apply does not create new local log entries.

## Key files

| File | Role |
|------|------|
| `src/gateway/services/tursoSyncLog.ts` | Schema, triggers, log read/prune, mute |
| `src/gateway/services/tursoDeltaSync.ts` | Delta push/pull by PK |
| `src/gateway/services/tursoSyncBridgeCore.ts` | `pushLocalDbToTurso`, `pullTursoToLocalDb` orchestration |
| `src/gateway/services/tursoSyncState.ts` | Log cursor persistence |
| `src/gateway/services/TursoSyncBridge.ts` | Pass/record cursors on push/pull |
| `src/gateway/services/TursoLinkedDbWatcher.ts` | Install local triggers on DB file change |
| `src/gateway/services/appRuntime/TursoDbAdapter.ts` | Install remote triggers on cloud write |

## Testing

### Unit tests (changelog triggers)

Requires Electron’s embedded Node (native `better-sqlite3` is built for Electron):

```bash
npm run build:gateway
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/vitest/vitest.mjs run tests/turso-sync-log.test.ts --project unit-backend
```

Covers:

- Insert/update/delete → changelog entries
- `withSyncMuted` suppresses echo
- `pruneSyncLogThrough` clears applied log
- Tables without PK skip triggers
- **2500-row table + 1 update → 1 log entry** (proves we avoid full-table rewrite path)

### Delta sync verification script

```bash
npm run build:gateway
npm run test:turso-delta-sync
```

Sections:

1. **Local** — changelog behavior, large-table single update, compiled symbol checks (no network)
2. **Live** (optional) — bootstrap + delta push against real Turso when memory server + `PAPR_API_KEY` are available

### Full bridge E2E (existing)

```bash
# Memory server required
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-turso-sync-bridge-e2e.mjs
```

## Cost impact (1M-row example)

| Operation | Before | After |
|-----------|--------|-------|
| Update 1 row | Read 1M local + DROP + INSERT 1M remote | Read 1 row local + upsert 1 row remote |
| Turso rows written per change | ~1M | 1 |
| Changelog storage | N/A | 1 row in `_papr_sync_log` until pruned |

## Limitations

- **No PK → no delta** — use snapshot fallback or add a primary key to the table.
- **First push to empty remote** — always bootstrap (full snapshot once).
- **Pre-CDC remote DBs** — first desktop push after upgrade may bootstrap or full-pull once; then delta applies.
- **Arbitrary `CREATE TABLE` on remote only** — triggers installed on bootstrap, delta touch, or first cloud write; exotic DDL-only paths may need a manual sync.

## Related docs

- `docs/PAPR_CLOUD_RUNTIME_PLAN.md` — cloud runtime overview
- `docs/TOOL_RESULT_TRUNCATION_STRATEGY.md` — unrelated but same “scale without full re-read” theme
- Enhancement 53 in `CLAUDE.md` — Turso “synced” false positive fix (fingerprints + dirty detection)
