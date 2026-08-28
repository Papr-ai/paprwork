# Turso Replica Spike — Results (2026-08-26)

**Script:** `scripts/spike-turso-embedded-replica.mjs`  
**Run:** `npm run spike:turso-replica`  
**Verdict:** **Plan A passes** — proceed with `@tursodatabase/sync`, **not** legacy `@libsql/client` embedded replicas.

---

## Executive summary

| Question | Answer |
|----------|--------|
| Can Turso be sole authority? | **Yes** — `push()` / `pull()` with local file |
| Does offline queue work? | **Yes** — local writes + `push()` on reconnect (`bootstrapIfEmpty: false`) |
| DDL through primary? | **Yes** — `ALTER TABLE` pushed and visible on remote |
| Per-user isolated DB? | **Yes** — separate Turso DBs don't leak tables |
| Cloud-enable import? | **Yes** — seed plain SQLite → read → `push()` to empty remote |
| Legacy `@libsql/client` embedded replica? | **Broken** — Turso returns `deprecated version of sync` / handshake timeout |
| Write latency (local + push)? | **p50 ~224ms, p95 ~281ms** (10 samples, single machine) |

**Recommendation:** Adopt **Turso Sync** (`@tursodatabase/sync`) as the replication layer. Delete syncV3 row/log path (keep git writer ops). Do **not** invest in `@libsql/client` `syncUrl` embedded replicas — Turso has deprecated that protocol on Papr's platform.

---

## Test results (12/12 pass)

| ID | Test | Result | Notes |
|----|------|--------|-------|
| 1 | Connect + bootstrap | PASS | ~0.5–4s (retry if host not ready) |
| 2 | Local write + push | PASS | ~250ms |
| 2b | Remote HTTP client sees row | PASS | `@libsql/client` remote read still works |
| 3 | Second device pull | PASS | ~150ms |
| 4 | Offline write → push | PASS | After remote provisioned |
| 5 | Rapid push/pull x5 | PASS | No duplicate/stuck state |
| 6 | DDL online | PASS | CREATE + ALTER pushed |
| 7 | Offline DDL batch | PASS | Multiple statements then push |
| 8 | Per-user DB isolation | PASS | Table in A not visible in B |
| 9 | Write+push latency | PASS | p95 281ms << 2000ms spike gate |
| 10 | Local seed import | PASS | Plain SQLite → push to remote |
| ER | Legacy embedded replica | PASS (expected fail) | Deprecated sync protocol |

---

## Critical findings

### 1. Legacy embedded replicas are dead on Papr Turso

`@libsql/client@0.14` with `syncUrl` + `sync()` fails:

```
you are using a client with a deprecated version of sync, that is not supported
in this platform. Please upgrade your client
```

Turso's own docs now recommend **[Turso Sync](https://docs.turso.tech/sync/usage)** for new projects instead of embedded replicas.

### 2. Turso Sync matches our target model

- **Local-first writes** — all reads/writes hit local file (good for jobs, agent, UI responsiveness)
- **Explicit `push()` / `pull()`** — maps cleanly to "offline = queue, reconnect = drain to primary"
- **No workspace log** — no LogMaterializer, no replay, no drift heal
- **Remote still readable** — cloud host keeps using `@libsql/client` HTTP client (`TursoDbAdapter`)

### 3. Provisioning race (~1.5s)

After `POST /databases/token`, Turso hostname may return **404 Host not found** for ~1–2s before first successful connect. Papr must **retry connect/push** on 404 — not a blocker, but required in production.

### 4. Latency profile

Measured: **local exec + push** (not push-only). Typical ~250ms per write+push on dev network. Acceptable for agent/job writes; mini-app hot paths may need:

- Batch push (debounced, like today's Turso push scheduler)
- Or optimistic UI + background push

Further spike needed for **100+ row batch push** and **concurrent writers** before deleting syncV3.

---

## What this means for the codebase

### Adopt

- `@tursodatabase/sync` — new `TursoReplicaService` wrapping connect/push/pull/checkpoint
- Debounced push scheduler (reuse pattern from `tursoPushScheduler.ts`)
- Provisioning retry on 404
- `bootstrapIfEmpty: false` for offline-first new local files (remote must exist first)

### Delete (after migration)

- Workspace log row layer (LogMaterializer, genesis, drift heal, etc.)
- Turso CDC fingerprint push/pull (`tursoDeltaPush`, etc.)
- `localFirstDbWrite` dual-authority path

### Keep

- Git writer ops (syncV3 code ship)
- `@libsql/client` for **cloud runtime** remote queries only
- App Files, Mongo job registry, namespace git pull

---

## Open questions (Phase 1, not spike blockers)

1. **Concurrent writers** — two desktops pushing same DB; Turso Sync says "last push wins" — need conflict UX
2. **Migration rebase** — offline DDL + primary moved — need agent handler (design done, not spike-tested with real conflict)
3. **better-sqlite3 coexistence** — jobs use better-sqlite3 today; Turso Sync uses its own engine — may need **one writer library** per linked DB file (don't open same path with both)
4. **Electron native module** — `@tursodatabase/sync` includes native bindings; verify `@electron/rebuild` on install

---

## Re-run

```bash
nvm use 24
# Papr Work gateway running OR PAPR_API_KEY in .env.local
npm run spike:turso-replica
```
