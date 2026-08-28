# Legacy → Plan A Replica Cutover

When `PAPR_TURSO_REPLICA_SYNC=replica-records`, legacy registry databases migrate to Turso Sync replica **on Upload now** for that app only. Same Turso instance (`d-*` / `tursoShortName`) — never delete/recreate.

## Decision tree

```
User: Upload now / push_cloud_sync({ appId }) / schema drift on legacy DB
  │
  ├─ syncMode already replica → papr_db_apply_migration / repair_cloud_sync
  │
  └─ syncMode legacy (Plan A rollout)
        │
        ├─ Real user schema drift (columns/tables differ)
        │     → papr_db_apply_migration (missing migrations)
        │     → NEVER delete_database / recreate Turso
        │
        ├─ Local-only legacy CDC artifacts only
        │     (turso_sync_last_change_id, turso_cdc_*)
        │     → push_cloud_sync({ appId }) or Upload now (strip + cutover)
        │     → Do NOT drop Turso or reseed from scratch
        │
        └─ Turso empty, local has rows
              → cutover seed_local (snapshot push to existing Turso)
```

## What cutover does

1. Backup local `data.db` → `.pre-replica.bak`
2. Drop local-only legacy CDC artifact tables
3. Final legacy push if dirty (same Turso)
4. Provision embedded replica file
5. Set `syncMode: "replica"`

## Upload now order (Plan A)

Same ordered pipeline for **Upload now** (UI) and **`push_cloud_sync({ appId })`** (agent) when default targets include both github + turso.

1. `applyLocalMigrationsForApp` — apply pending local migrations
2. Per-app legacy → replica cutover
3. Replica push
4. Git writer + publish

## Never do

- `delete_database` / create new Turso when legacy already has data on `d-*`
- `bash` / `sqlite3` INSERT on registry DB files (use `papr_db_*` or replica path)
- Legacy `schema drift heal` under `replica-records` (disabled)
- `force_local` when Turso has more rows than local (use `bootstrap_remote` after restore)

## Recovery after mistaken delete/recreate

1. Restore `data.db` from `.pre-replica.bak` or known good backup
2. Fix `databases.json` to original `tursoShortName`
3. `repair_cloud_sync({ strategy: "bootstrap_remote" })` if Turso is empty/stale
