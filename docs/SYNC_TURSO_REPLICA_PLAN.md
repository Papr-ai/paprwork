# Sync Plan — Turso Embedded Replica (Plan A)

**Status:** Spike passed (2026-08-26) — see [`SYNC_TURSO_REPLICA_SPIKE_RESULTS.md`](./SYNC_TURSO_REPLICA_SPIKE_RESULTS.md)  
**Decision gate:** ✅ Proceed with Plan A using **`@tursodatabase/sync`** (not `@libsql/client` embedded replicas).  
**Supersedes as primary direction:** [`SYNC_REPLICA_GENESIS_AND_AUTHORITY_PLAN.md`](./SYNC_REPLICA_GENESIS_AND_AUTHORITY_PLAN.md) (Plan B — workspace log + checkpoint fallback)  
**Still valid:** [`SYNC_CONTRACT.md`](./SYNC_CONTRACT.md) (product rules), git writer ops, per-app repos

---

## Target in one sentence

**When cloud is on:** Turso primary is the **only** row/schema authority; every client (desktop, cloud, sandbox) is a **replica**; offline = **outbox queue**, never authority flip. **When cloud is off:** plain local SQLite, no sync layer.

---

## Master table (what we have → what we want)

| Layer | Today (production) | Plan A (target) | Action |
|-------|-------------------|-----------------|--------|
| **Row authority (cloud on)** | Implicit dual: local SQLite + Turso via log | Turso primary only | **Change** |
| **Write path** | Local first → `_papr_sync_log` → log ship → Turso → **replay back** (`LogMaterializer`) | Single path: write **primary**; replica `sync()` tails frames | **Replace** |
| **Read path (desktop)** | Local SQLite (may be stale vs Turso) | Local embedded replica (last synced frames) | **Change** |
| **Read path (cloud)** | Turso direct (`TursoDbAdapter`) ✅ | Same | **Keep** |
| **Ordering / merge** | Workspace log seq + HLC + LWW replay | Primary serialization (native) | **Remove log** |
| **Offline (cloud on)** | Local writes + CDC; reconnect = pull/push merge | Provisional local apply + **outbox → primary**; re-tail | **Replace** |
| **Offline (cloud off)** | Local SQLite authority ✅ | Same (no Turso) | **Keep** |
| **First cloud enable** | Ship CDC + log + genesis hash | One-time **import local → Turso primary**, reopen as replica | **Build** |
| **Schema (cloud on)** | Git files + drift-heal + log schema replay | Local migration **file** → apply immediately; **online = DDL on Turso primary**; `schema_migrations` ledger in DB | **Simplify** |
| **Schema offline** | Local migrations (blocked when cloud on — P0) | Provisional local DDL; reconnect = **pull → reconcile → push** with typed errors | **Build** |
| **Migration ↔ git** | Implicit gate (Upload / log replay order) | Git = **collab ship only**, not exec gate — same as app code | **Simplify** |
| **App code sync** | Per-app git writer ops + outbox | Same | **Keep** |
| **Namespace git** | Pull-only workspace metadata | Same (not row sync) | **Keep** |
| **Job metadata** | Mongo registry dual-write | Same (orthogonal) | **Keep** |
| **Large assets** | App Files (object storage) | Same | **Keep** |
| **Turso backup** | Turso PITR / S3 durability (vendor) | Same — **no** duplicate blob checkpoint per write | **Keep** |
| **Drift heal / replay sanitizers** | Required today (`schemaDriftHeal`, skip heuristics) | **Not needed** — drift can't form with one authority | **Remove** |
| **Upload (`flushAppNow`)** | Log catch-up → push → log catch-up | Writer ops + publish only (no log catch-up) | **Simplify** |

---

## KEEP (do not delete)

| Component | Location | Why |
|-----------|----------|-----|
| Per-app git writer ops | `syncV3/collectAppOpFiles.ts`, `pushAppViaWriterOps.ts`, `AppOpsClient.ts`, `OidCache.ts` | Code PR/collab — unrelated to row sync |
| Writer outbox (code) | `syncV3/SyncOutbox.ts`, `outboxFile.ts` | Git file ship queue — keep; **not** row outbox |
| Cloud sync git pull | `cloudSync/*` (pull, clone, hygiene) | Namespace + app repo pull |
| `flushAppNow` (trimmed) | `cloudSync/flushAppNow.ts` | Upload = writer ops + publish (drop log/Turso push steps) |
| Turso cloud runtime | `appRuntime/TursoDbAdapter.ts` | Already thin |
| Turso provisioning / naming | `tursoDatabaseNaming.ts`, platform schema | Per-app / per-user DB creation |
| Migration **files** on disk + git | `databases/{slug}/migrations/` | DDL **text** for PR/collab; agent reads **local path**, git ship async |
| App Files | `appFiles/*` | User PDFs/video — not DB rows |
| Local-only mode | `isCloudSyncEnabled()` gates | Pure SQLite when cloud off |
| P0 triage (until spike lands) | skip replay heuristics | Stop bleeding; delete after Plan A |

---

## BUILD (Plan A — new or repurposed)

| # | What | Notes |
|---|------|-------|
| 1 | **Spike** | Embedded replica + offline write queue + DDL-through-primary + per-user DB + UI latency |
| 2 | **`TursoReplicaService`** | Wrap `@tursodatabase/sync`: `connect`, `push`, `pull`, `checkpoint`; provisioning retry on 404 |
| 3 | **Primary write router** | All `/api/db/write`, agent tools, jobs → primary when cloud on (never dual-write local+remote separately) |
| 4 | **Offline outbox (rows)** | Repurpose concept from `SyncOutbox` / `_papr_sync_log` → queue applies to primary on reconnect |
| 5 | **`paprDb` agent API** | Thin router: `exec`, `applyMigration`, `syncStatus`, `push`, `pull` — direct engine errors, no syncV3 middle layer |
| 6 | **Migration apply (online)** | Read local file → exec DDL on **Turso primary** → record ledger → `pull()` local replica |
| 7 | **Migration apply (offline)** | Read local file → exec local (provisional) → on reconnect: **pull first** → reconcile ledger → push or **typed error** |
| 8 | **Migration rebase handler** | Agent-facing: skip / rebase / fix-up when push fails (e.g. cloud already at 0008) |
| 9 | **Cloud-enable cutover** | Import local SQLite → create/seed Turso primary → reopen desktop file as replica |
| 10 | **Sandbox thin path** | Remove full log materialize in cloud agent sandboxes; Turso direct only |
| 11 | **Connectivity UX** | Online / offline / draining / conflict / `pendingPush` states in sync UI |
| 12 | **Agent tools** | `repair_cloud_sync` → re-`sync()` from primary; structured conflict errors |

---

## REMOVE (after spike passes — ~syncV3 row layer)

| Component | Location | Why it dies |
|-----------|----------|-------------|
| Workspace log client + ship | `WorkspaceLogClient.ts`, `workspaceLogBatchShip.ts`, `workspaceLogSync.ts` | Ordering = Turso primary |
| Log materializer + replay | `LogMaterializer.ts`, `logReplayRowSql.ts`, `replaySafeSql.ts`, `syncLogToRowSql.ts` | No replay into local |
| Genesis / cursor / materialized gates | `workspaceLogGenesisCutover.ts`, `workspaceLogCursor.ts`, `workspaceLogMaterialized.ts`, `workspaceLogCutoverState.ts` | Replica sync replaces |
| Schema drift heal | `schemaDriftHeal.ts`, `shipSchemaMigrationLog.ts` | DDL on primary + pull-before-push; no log heal |
| Ensure replica ready (log path) | `ensureReplicaReady.ts` | Replaced by `sync()` |
| Local-first DB write (dual path) | `syncV3/localFirstDbWrite.ts` | Single write path |
| Turso CDC fingerprint push/pull | `tursoDeltaPush.ts`, `tursoDeltaPull.ts`, `tursoSyncBridgeCore.ts` (row CDC half) | Replica protocol |
| Log catch-up in Upload | `flushAppNow` catch-up loops | Upload ≠ sync |
| Memory server `_papr_oplog` append API | memory server (Python) | Retire row/schema log; optional slim audit table later |
| P0 skip heuristics | `migrationSchemaLocal.ts`, missing-table skips | No log replay |

**Keep syncV3 folder for writer/git pieces** — delete ~60% of files, not the whole directory.

---

## Spike (pass/fail gate)

**Pass all → execute Plan A (delete row sync layer). Any fail → Plan B ([`SYNC_REPLICA_GENESIS_AND_AUTHORITY_PLAN.md`](./SYNC_REPLICA_GENESIS_AND_AUTHORITY_PLAN.md)).**

| # | Test | Pass criteria |
|---|------|---------------|
| 1 | Embedded replica open | Desktop opens job/app `.db` as replica of Turso primary; reads work |
| 2 | Write → primary | Insert on desktop visible on cloud host without log ship |
| 3 | `sync()` tail | Second device sees write after sync (no materializer) |
| 4 | Offline row queue | Airplane mode writes → provisional local → reconnect drains to primary in order |
| 5 | Rapid connect/disconnect | No duplicate rows / no stuck outbox after 10 flaps |
| 6 | DDL through primary | Online `applyMigration` → Turso exec → `pull()` → replicas converge |
| 7 | Offline DDL | Provisional local → reconnect **pull first** → push or typed rebase error |
| 8 | Per-user isolated DB | Same model on isolated Turso DB (not just shared app DB) |
| 9 | UI latency | Hot mini-app write path ≤ acceptable (define: e.g. p95 < 200ms local-then-forward OR sync) |
| 10 | Cloud-enable import | Local-only DB → enable cloud → seed primary → replica mode |
| 11 | Migration no-git-gate | Write `0007_foo.sql` locally → `applyMigration` before git Upload → succeeds |
| 12 | Cloud-ahead offline | Device A offline applies 0007; device B already at 0008 → reconnect **pull → push fails loud** |
| 13 | Online DDL path | Online `applyMigration` hits Turso HTTP directly; local replica updated via `pull()` |

**Spike artifact:** `scripts/spike-turso-embedded-replica.mjs` — **12/12 pass** (2026-08-26) for tests 1–10. Tests 11–13 = Phase 1 follow-up.

**Run:** `npm run spike:turso-replica`

---

## Phases (after spike pass)

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| **0 — Spike** | 1–2 weeks | Pass/fail verdict + prototype |
| **1 — Primary write path** | 2–3 weeks | Router + embedded replica; **`paprDb` API**; online migrations on Turso primary |
| **2 — Offline outbox** | 2–3 weeks | Row + DDL provisional queue; **pull-before-push** reconnect; typed agent errors |
| **3 — Cutover + sandboxes** | 1–2 weeks | **Existing-user cutover** (buckets B/C/D); cloud-enable seed; strip sandbox materialize |
| **4 — Delete legacy** | 2–3 weeks | Remove log layer; trim `flushAppNow`; delete tests for removed paths |
| **5 — UX + agent** | 1 week | Sync status UI (`pendingPush`), `repair_cloud_sync`, agent migration docs |

**Do not start Phases 1–5 until Phase 0 passes.**

---

## Migrations (simplified model)

**Principle:** Git is for **collaboration and ship** (PRs, forks, history). Turso is for **applied schema** when cloud is on. The agent runs SQL and gets **real errors** from whichever engine executed — no syncV3 log replay, no “wait for git” gate.

### Git is not an execution gate

Same as app code: write locally → run immediately → git Upload ships async.

```
1. Agent writes databases/{slug}/migrations/0007_foo.sql  (local app folder)
2. Agent calls paprDb.applyMigration('0007_foo')
      → reads local file, exec DDL, records in schema_migrations
      → returns { applied: true } or { error: "duplicate column: status" }
3. Writer ops / Upload ship migration file to git when ready (orthogonal)
```

Team members only see migration **files** after git/PR — but the authoring device must not block on that.

### Online vs offline (cloud sync enabled)

| Mode | Rows | Migrations |
|------|------|------------|
| **Online** | Write primary (or local + immediate `push()`) | **Exec DDL on Turso primary** (Neon-like) → record ledger → `pull()` local replica for jobs |
| **Offline** | Local replica write → `{ pendingPush: true }` | Exec local (provisional) → `{ applied: true, pendingPush: true }` |
| **Reconnect** | **`pull()` first** → reconcile → `push()` or typed error | Same — **never push blind** |

When **cloud is off**: plain local SQLite only — no Turso, no sync, migrations local-only.

### Anti-drift rules (why this is not today’s drift)

Today’s pain came from **two authorities** (local + log + Turso) + silent replay. Plan A avoids that:

1. **One authority** — Turso primary when cloud is on
2. **Online migrations never “local only”** — DDL hits primary directly; no Upload/log catch-up window
3. **Offline reconnect always `pull()` before `push()`** — cloud head wins if ahead
4. **Failures are loud** — agent gets `pushError: "duplicate column: status"`, not silent LogMaterializer skip
5. **No log replay for schema** — delete `shipSchemaMigrationLog`, drift-heal, migration log append

| Scenario | Outcome |
|----------|---------|
| Solo offline, cloud unchanged | `push()` applies 0007 to Turso ✅ |
| Offline 0007, cloud at 0006 | `push()` applies 0007 ✅ |
| Offline 0007, cloud already at 0008 (other device) | `push()` **fails** → agent `pull()`, skip/rebase/fix-up ✅ |
| Online apply | Turso exec first → all replicas converge via `pull()` ✅ |

### Agent API (thin router)

No syncV3 middle layer — route to the engine that will actually run the statement:

```typescript
paprDb.exec(sql)                    // direct error from Turso HTTP (online) or local replica (offline)
paprDb.applyMigration(id)           // read local migrations/{id}.sql; online → Turso primary
paprDb.syncStatus()                 // { online, pendingPush, pendingOps, lastPushError }
paprDb.push() / paprDb.pull()       // explicit sync; reconnect path uses pull-first
```

**Example — offline then reconnect:**

```typescript
write_file('databases/main/migrations/0007_foo.sql', sql)
const r = await paprDb.applyMigration('0007_foo')
// offline: { applied: true, pendingPush: true }

// on reconnect:
await paprDb.pull()                 // cloud head first
const p = await paprDb.push()
// { ok: true } or { error: "duplicate column: status" }  ← agent can fix
```

### What we delete (migration-specific)

| Remove | Why |
|--------|-----|
| `applyLocalMigrationsForApp` skip when cloud on (P0) | Agent applies directly again |
| `schemaDriftHeal`, `shipSchemaMigrationLog` | No log-based schema convergence |
| Workspace log schema migration append/replay | DDL on primary only |
| Implicit “migration must be in git before apply” ordering in Upload | Git ship ≠ exec gate |

**Keep:** migration **files** in app repo (writer ops) for PR review; `schema_migrations` table in Turso as applied-state ledger.

---

## Existing users — cutover at launch (don’t break prod)

When Plan A ships, users are **not** all starting from zero. Handle **per linked database** (`databases.json` entry), not per app wholesale. **Reuse existing Turso databases** — do **not** mint a new Turso for apps that already synced.

### User buckets

| Bucket | Today | Cutover |
|--------|-------|---------|
| **A — Cloud off** | Local SQLite only, no Turso | **No change** until they enable cloud |
| **B — Cloud on, never had Turso rows** | Registry + local file, remote empty/missing | **Seed:** local snapshot → `push()` → replica mode |
| **C — Cloud on, already on Turso** | Dual path (local + CDC/log + Turso) — most prod team users | **Reattach:** same Turso name, one-time reconcile → replica mode |
| **D — Drift / quarantine** | Local ≠ Turso (schema or rows) | **Block** auto-cutover → `repair_cloud_sync` / agent fixup |

### First cloud enable (bucket A → B)

User turns on cloud sync for the first time:

```
1. For each linked db in databases.json:
2.   Provision Turso if missing (same tursoShortName: d-{dbId8} / j-{jobId8})
3.   Backup local data.db → data.db.pre-replica.bak
4.   If remote empty && local has rows:
        seed via push() (spike test 10 — proven)
5.   Reopen local file as @tursodatabase/sync replica
6.   Mark databases.json: syncMode: "replica", cutoverAt: ISO
```

No workspace log genesis. No CDC fingerprint path.

### Already synced to Turso (bucket C — the important case)

**Do not create a new Turso DB.** The team’s cloud runtime, web apps, and collaborators already use `d-xxxxxxxx` / per-user replicas on that name.

One-time cutover on **first launch after app update**:

```
1. Quiesce writes for this db (brief — seconds)
2. Flush legacy path one last time (optional safety):
      push any pending CDC / log tail so Turso is as complete as we can make it
3. Classify remote vs local:
      remoteTableCount, localTableCount, schema fingerprint, row-count hints
4. Default rule: **Turso wins** when remote has syncable tables
      (protects team/web data; local was always a cache in prod)
5. Backup local → data.db.pre-replica.bak
6. pull() from existing Turso into local replica file
7. Reopen as replica; all new writes → primary
8. Mark cutover complete; stop LogMaterializer / CDC for this db
```

**Why Turso wins by default for bucket C:** In the current model, cloud host and teammates already read/write Turso. Wiping or replacing remote with a stale local snapshot would break live apps. Local was never the sole authority for shared apps — it just *felt* that way on desktop.

**When local wins instead:** Remote empty (never pushed) but local has data — same as bucket B seed path.

### Solo desktop user who never successfully pushed

Effectively bucket B even if “cloud on” in settings:

- Remote empty or only scaffold tables
- Local has real rows  
→ **Seed from local** via `push()`, not pull from empty remote.

Detection: `remoteTableCount === 0` (or only `_papr_*` meta) && local row count > 0.

### Pending offline / unpushed local changes at cutover

Before step 6 (pull) for bucket C:

```
1. If legacy dirty flags / unpushed CDC exists:
      run final legacy push OR export diff for user review
2. If final push succeeds → proceed with Turso-wins pull
3. If push conflicts → bucket D (repair required)
```

After cutover, offline queue is **only** the new provisional outbox — no legacy log replay.

### Local ahead of Turso (unpushed desktop work)

**They should not lose local work silently.** Cutover order is always **push attempt → then pull**, never blind pull when local is dirty.

| Situation | What happens | Data loss? |
|-----------|--------------|------------|
| Local has unpushed rows, push **succeeds** | Turso catches up → `pull()` aligns replica → app sees merged state | **No** |
| Local ahead, remote **empty** | Bucket B: `push()` seeds Turso from local | **No** |
| Local ahead **and** remote has different rows, push **conflicts** | Cutover **blocked** (bucket D) — user/agent picks repair | **No** (cutover waits; `.pre-replica.bak` kept) |
| Local ahead, user **forces** “accept cloud” repair | Local file replaced from Turso pull | **Yes** — unpushed local-only rows lost on **active** file; recoverable from `.pre-replica.bak` if needed |
| Cutover bug: pull without push while dirty | Would overwrite local — **must not ship** | **Yes** — this is the failure mode we guard against |

**Detection before pull:** legacy dirty flags, `lastPushedLogId` behind `max(_papr_sync_log)`, or row-count / fingerprint hint that local > remote.

**App impact (wired to local):** Mini-apps and jobs **keep the same wiring** — `data-sources.json` → same `localPath` (`~/Papr/data/databases/{slug}/data.db`), same `/api/db/query` and `/api/db/write`. Cutover changes **how the gateway syncs that file**, not the app contract:

```
Before:  app → /api/db/* → gateway → local SQLite (+ background CDC to Turso)
After:   app → /api/db/* → gateway → local replica file (reads)
                              └─ online writes → Turso primary → pull() refreshes local
```

The app still reads/writes the **same path**. After a successful push-before-pull cutover, the local file contains Turso truth **including** what was only local before. Jobs using `better-sqlite3` on that path see the same rows post-`pull()`.

**If cutover is blocked (bucket D):** App keeps working on **legacy path** until repair — we do not half-switch one db mid-flight.

### Push conflicts at cutover (both sides changed)

Cutover runs a **final legacy merge push** (existing CDC/log + LWW on `_papr_row_version` / `_papr_updated_at`). Three outcomes:

```
finalPush()
  ├─ success, converged     → pull() → cutover complete
  ├─ success, partial LWW   → losers logged → pull() → cutover (surface loss count in UI)
  └─ hard fail              → cutover BLOCKED → repair required
```

**Hard fail** = schema mismatch, quarantine, unmergeable duplicate PKs, or push error that isn’t resolved by LWW (e.g. `UNIQUE constraint`, missing column on remote).

**While blocked:**

| Layer | Behavior |
|-------|----------|
| **Cutover flag** | `syncMode` stays `legacy` for this db — no replica switch |
| **Mini-app / `/api/db/*`** | Unchanged — still reads/writes local SQLite via gateway (today’s path) |
| **Sync UI** | “Conflict — repair before replica upgrade” + loss/conflict summary if partial |
| **Agent** | `repair_cloud_sync({ dbId, strategy })` — structured, not silent |

**Repair strategies (agent or Settings):**

| Strategy | What it does | Data loss |
|----------|--------------|-----------|
| **`merge_lww`** (default try first) | One last pull → LWW push → re-test; auto-cutover if converged | Only LWW losers (logged, same as today’s bidirectional) |
| **`accept_cloud`** | Backup local → pull Turso over local file → cutover | Unpushed local-only rows lost on active file (`.pre-replica.bak`) |
| **`force_local`** | Backup remote snapshot note → push local to Turso → cutover | Remote-only rows overwritten (explicit confirm) |
| **`export_conflicts`** | Return conflicting `(table, pk, localVersion, remoteVersion)` for agent SQL fixup | None — cutover still blocked until fixed |

After any successful repair + cutover, legacy CDC/log path is **off** for that db — ongoing conflicts use Turso Sync + same LWW columns, surfaced via `paprDb.push()` errors (not Upload/log mystery).

**Schema conflicts at cutover** (e.g. local applied `0007`, Turso at different migration): always block row cutover until `applyMigration` / ledger aligned — same repair flow as bucket D migrations section.

### Drift / quarantine (bucket D)

If schema fingerprints diverge or quarantine flag set (`.turso-sync-state.json`):

- **Do not** auto-cutover
- Surface in Settings + sync chip: “Database needs repair before replica upgrade”
- Agent `repair_cloud_sync({ dbId })` options:
  - **Accept cloud** — backup local, pull overwrites
  - **Force local seed** — explicit user/agent choice (destructive to remote — confirm)
  - **Schema fix** — apply missing migrations on primary, then retry

This is the one place we still need human/agent judgment — same as today’s drift, but **once**, then the problem class goes away.

### What stays the same across cutover

| Asset | Action |
|-------|--------|
| **Turso database name** | Keep `tursoShortName` in `databases.json` |
| **App code / git** | Unchanged — writer ops continue |
| **Cloud host runtime** | Already Turso direct — no cutover needed |
| **Per-user isolated DBs** | Same cutover logic per user segment |
| **Cloud-off apps** | Skip entirely — plain SQLite forever |
| **Mongo job metadata** | Orthogonal — no row cutover |

### What we delete after cutover (per db)

- Workspace log cursor / materialized state for that replica
- `_papr_sync_log` CDC path (local file can drop log table on next checkpoint)
- `LogMaterializer` catch-up for that db
- Genesis cutover records in `workspace-log-cutover.json`

### Rollout safety

| Guard | Why |
|-------|-----|
| Per-db cutover flag in `databases.json` | Resume if app crashes mid-cutover |
| `.pre-replica.bak` before any destructive step | User can rollback manually |
| Turso PITR (vendor) | Ops rollback if seed wrong remote |
| Version gate: desktop ≥ X uses replica router | Old builds keep legacy path until updated |
| Cloud/web unchanged | They already hit Turso — no dual cutover |

### Spike / Phase 3 tests to add

| # | Test |
|---|------|
| 14 | Bucket B: local-only history → first cloud enable → seed → replica |
| 15 | Bucket C: remote has rows → cutover pull → desktop matches cloud |
| 16 | Bucket C + unpushed local: final legacy push → cutover → no row loss |
| 17 | Bucket D: schema drift → cutover blocked → repair → retry succeeds |

---

## Docs, tools, and surfaces to adjust

Plan A changes **how sync works**, not the mini-app `/api/db/*` contract. Most agent-facing work is **retire log/Upload-as-DB-sync guidance** and **add direct `paprDb` tools**.

### Agent tools

| Tool | Action |
|------|--------|
| **`papr_db_exec`** (new) | Run SQL; returns engine error from Turso (online) or local replica (offline) |
| **`papr_db_apply_migration`** (new) | Read local `migrations/{id}.sql`; online → Turso primary; offline → provisional + `pendingPush` |
| **`papr_db_sync_status`** (new) | `{ online, pendingPush, pendingOps, syncMode, cutoverBlocked, lastPushError }` per dbId |
| **`papr_db_push` / `papr_db_pull`** (new) | Explicit sync; document pull-before-push on reconnect |
| **`repair_cloud_sync`** (new) | Cutover + drift: `merge_lww`, `accept_cloud`, `force_local`, `export_conflicts` |
| **`get_cloud_sync_status`** (update) | Add replica fields; de-emphasize CDC dirty / log catch-up; keep GitHub + publish + heartbeat |
| **`push_cloud_sync`** (update) | **`targets: ['github']`** = code only (unchanged). **`targets: ['turso']`** → thin wrapper around `papr_db_push` per linked db (not log ship). Default `appId` push = git writer ops + publish — **not** row sync |
| **`query_cloud_turso`** (keep) | Cloud-side read-only debug on `apps.papr.ai` / remote HTTP — still useful |
| **`create_database` / `attach_database`** (update) | Descriptions: apply migrations immediately via `papr_db_apply_migration`; git ship async |
| **`inspect_cloud_repo` / `read_cloud_repo_file`** (keep) | Code PR path unchanged |

Register in [`src/core/tools/index.ts`](../src/core/tools/index.ts) (new `paprDbTools` category or extend `databaseTools` + `cloudObservability`).

### System prompt & agent docs

| File | Action |
|------|--------|
| [`SystemPrompt.ts`](../src/core/agents/SystemPrompt.ts) | Rewrite cloud/sync sections: Turso primary, no “Upload now fixes DB rows”, migration = local file + `applyMigration`, pull-before-push, `repair_cloud_sync` |
| [`APP_AND_JOBS_GUIDE.md`](../src/resources/agent-docs/APP_AND_JOBS_GUIDE.md) | **Major** — schema migrations §, cloud debug workflow, remove workspace-log / delta-sync / “run_job to apply migration” as primary path |
| [`CLOUD_VS_DESKTOP_GUIDE.md`](../src/resources/agent-docs/CLOUD_VS_DESKTOP_GUIDE.md) | Row authority = Turso when cloud on; Upload = code + publish only |
| [`00-START-HERE.md`](../src/resources/agent-docs/00-START-HERE.md) | Tool catalog: add `papr_db_*`, update `push_cloud_sync` semantics |
| [`PRODUCT_ARCHITECT_GUIDE.md`](../src/resources/agent-docs/PRODUCT_ARCHITECT_GUIDE.md) | Sync architecture bullets if present |
| [`jobDbSchemaGuard.ts`](../src/core/utils/jobDbSchemaGuard.ts) | Point blocked raw DDL at `papr_db_apply_migration` (not “wait for Turso replay”) |
| [`bash.ts`](../src/core/tools/bash.ts) / schema guard msgs | Same messaging update on synced paths |

Optional new focused doc: **`PAPR_DB_SYNC_GUIDE.md`** (agent) — can start as section in APP_AND_JOBS and split later.

### Binding product docs

| File | Action |
|------|--------|
| [`SYNC_CONTRACT.md`](./SYNC_CONTRACT.md) | **Update** §4 pull-before-push, §5 conflicts, row authority = Turso primary — keep as binding spec |
| [`SYNC_TURSO_REPLICA_PLAN.md`](./SYNC_TURSO_REPLICA_PLAN.md) | This doc — primary implementation plan |
| [`SYNC_V3_IMPLEMENTATION_PLAN.md`](./SYNC_V3_IMPLEMENTATION_PLAN.md) | Frozen — historical |
| [`SYNC_ARCHITECTURE_V3.md`](./SYNC_ARCHITECTURE_V3.md) | Header: superseded by Plan A for row sync; writer ops section still valid |
| [`SYNC_REPLICA_GENESIS_AND_AUTHORITY_PLAN.md`](./SYNC_REPLICA_GENESIS_AND_AUTHORITY_PLAN.md) | Plan B fallback only |
| [`CLAUDE.md`](../CLAUDE.md) | New learning entry when shipped; link Plan A |
| [`docs/TURSO_CHANGELOG_CDC_SYNC.md`](./TURSO_CHANGELOG_CDC_SYNC.md) etc. | Mark **deprecated** or archive — CDC path removed |

### UI (user-facing, not agent)

| Surface | Action |
|---------|--------|
| [`CloudSyncDetails.tsx`](../ui/components/Settings/CloudSyncDetails.tsx) | `pendingPush`, `cutoverBlocked`, online/offline; simplify Turso chip copy |
| [`WebSyncPopover.tsx`](../ui/components/Apps/WebSyncPopover.tsx) | Upload = code; separate “DB sync” status from git |
| [`appCloudSyncStatus.ts`](../ui/utils/appCloudSyncStatus.ts) | Map new gateway `/api/sync/items` fields |
| [`memoryWorkspaceHealth.ts`](../ui/utils/memoryWorkspaceHealth.ts) | Remove log/genesis health signals if present |

### Gateway / mini-app API (minimal change)

| Endpoint | Action |
|----------|--------|
| `/api/db/query`, `/api/db/write`, `/api/db/exec` | **Keep contract** — route internally via `TursoReplicaService` + same `localPath` |
| `/api/sync/items`, `/api/sync/status` | Add replica / pendingPush / cutover fields |
| Upload / `flushAppNow` | Docs + agent guidance: **git + publish only** — trim Turso/log steps in code Phase 4 |

Mini-apps **do not** change unless they incorrectly assumed Upload syncs DB rows.

### Implementation code (reference — Phase 1–4)

Replace row layer: `TursoSyncBridge` CDC half, `LogMaterializer`, `WorkspaceLogClient` row append, `TursoLinkedDbWatcher` log ship, `applyLocalMigrationsForApp` cloud-off block, `schemaDriftHeal`, `flushAppNow` log catch-up.

**Keep:** writer ops, `DbRouter` local read path (replica file), `TursoDbAdapter` cloud, `DatabaseRegistryService`, App Files.

Build: `TursoReplicaService`, primary write router, cutover orchestrator, `CloudObservabilityService` updates.

### Memory server (Python)

| Area | Action |
|------|--------|
| Workspace log row/schema append | Retire or no-op for new namespaces |
| `schema_migration_executor.py` | Cloud sandbox: Turso direct DDL only (align with desktop) |
| Publish / repo-file / Turso tokens | **Keep** |

### Tests & scripts

| Action |
|--------|
| **Delete / retire:** `workspace-log-replay*.test.ts`, `LogMaterializer` tests, `turso-delta-*` CDC tests, genesis cutover tests |
| **Add:** `turso-replica-service.test.ts`, `papr-db-tools.test.ts`, cutover bucket 14–17, migration no-git-gate |
| **Update:** `turso-sync-status.test.ts`, `web-ready.test.ts`, `push-app-now` integration (no log catch-up) |
| **Scripts:** extend `spike-turso-embedded-replica.mjs`; add `cutover-replica.mjs` for dogfood |
| **`package.json`:** new test scripts; deprecate `test:turso-sync-session-e2e` when CDC removed |

### Phase ownership

| Phase | Docs/tools work |
|-------|-----------------|
| **1** | `TursoReplicaService`, gateway router, **`papr_db_*` tools**, SystemPrompt + APP_AND_JOBS migration § draft |
| **2** | `repair_cloud_sync`, sync UI fields, update `get_cloud_sync_status` / `push_cloud_sync` |
| **3** | Cutover UX copy, bucket D repair docs, SYNC_CONTRACT update |
| **4** | Archive deprecated docs, delete misleading agent guidance, CLAUDE.md entry, test script cleanup |
| **5** | Polish agent workflow examples in 00-START-HERE + QUICK_EXAMPLES |

---

## Plan B (fallback — already specced)

If Turso offline writes / embedded replicas fail spike: finish [`SYNC_REPLICA_GENESIS_AND_AUTHORITY_PLAN.md`](./SYNC_REPLICA_GENESIS_AND_AUTHORITY_PLAN.md) — log genesis + compact + bootstrap from Turso + stop replay on Upload. More code, same product rules.

---

## Mental model cheat sheet

```
Cloud ON + online:   DDL → Turso primary (direct) → pull() local replica
                     rows → Turso primary → replicas sync()

Cloud ON + offline:  local writes (provisional) → reconnect: pull() → push() or loud error
                     NOT a second authority — queue until primary acks

Cloud OFF:           plain SQLite, no Turso, no sync layer

Code:                git writer ops (ship async — not exec gate)

Schema files:        local migrations/*.sql (agent reads disk)
Schema applied:      schema_migrations in Turso (when cloud on)
Git:                 PR/collab for migration text — same timing as app code
```

---

## Housekeeping

- **Park** Architecture Navigator V3 doc until spike verdict.
- **Update** [`SYNC_V3_IMPLEMENTATION_PLAN.md`](./SYNC_V3_IMPLEMENTATION_PLAN.md) header → frozen; Plan A primary (done 2026-08-26).
- **Do not** finish syncV3 row/log phases while spike runs.
