# Sync Replica, Genesis, and Authority Plan

**Status:** Draft (2026-08-24)  
**Supersedes:** Nothing — extends [`SYNC_ARCHITECTURE_V3.md`](./SYNC_ARCHITECTURE_V3.md), [`SYNC_CONTRACT.md`](./SYNC_CONTRACT.md), [`SYNC_V3_IMPLEMENTATION_PLAN.md`](./SYNC_V3_IMPLEMENTATION_PLAN.md)

**Context:** P0 skip-on-missing replay unblocked Upload for stale log entries (e.g. `person_tags` → `person_label`). That is triage, not the target model. This doc defines the long-term replica modes, authority rules, genesis/compaction, cloud-thin Turso, and fork/collaborator behavior.

---

## TL;DR

| Principle | Rule |
|-----------|------|
| **Row authority when cloud on** | Turso (+ workspace log ordering) |
| **Row authority when cloud off** | Local SQLite |
| **Code + migration files** | Per-app git repo via writer ops; schemaOwnerAppId owns `databases/{slug}/migrations/` |
| **Cloud runtime** | Always **thin** — query Turso directly; never bulk-bootstrap |
| **Desktop runtime** | **Materialized replica** — local SQLite is cache/offline copy; bootstrap once when empty, then tail log |
| **Fork / collaborator data** | **Community fork:** new owner, new empty Turso. **Team collab:** optional shared Turso (team setting), like shared `.env` — not community default |
| **Fork / collaborator schema** | Migrations via **PR to owner's repo**; no direct schema push to owner Turso |
| **Genesis** | Rare checkpoint: hash + cursor jump + log compaction — **not** a full Turso export on every sync |

---

## 1. Problem statement

Today we mix three concerns:

1. **Ordered merge** (workspace log / oplog)
2. **Materialized state** (Turso + local SQLite)
3. **Schema definition** (git migration files)

When local schema gets ahead of unmaterialized log history (renames, offline migrations, fork installs), replay-from-genesis breaks or requires skip-heuristics.

Separately:

- **Desktop** assumes the creator already has data locally; collaborators/forks get **blank SQLite**.
- **Cloud sandboxes** incorrectly replay the full log into local SQLite (expensive, fragile).
- **Authority** is implicit (local-first writes + async ship) rather than explicit (cloud-on → Turso-first).

We need one model that works for: owner desktop, owner web/mobile → desktop, collaborator fork, second device, and offline → cloud flip.

---

## 2. Target architecture: two replica modes

```
                    ┌─────────────────────────────────────┐
                    │     Workspace log (_papr_oplog)      │
                    │  ordering + multi-writer merge (HLC)   │
                    └──────────────┬──────────────────────┘
                                   │ append (memory server)
                                   ▼
                    ┌─────────────────────────────────────┐
                    │              Turso                   │
                    │   authoritative row store (cloud)    │
                    └──────────────┬──────────────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
              ▼                                         ▼
   ┌──────────────────────┐               ┌──────────────────────┐
   │  FULL replica         │               │  THIN client          │
   │  (desktop default)    │               │  (cloud always)       │
   │  Local SQLite cache   │               │  Query Turso direct   │
   │  Bootstrap once       │               │  Result micro-cache   │
   │  Tail log after genesis│              │  No local bulk copy   │
   └──────────────────────┘               └──────────────────────┘
```

### 2.1 Full replica (desktop)

- Local SQLite is a **materialized cache** for offline, agent jobs, and fast reads.
- **Not** the source of truth when cloud sync is enabled.
- Sync = ship local CDC → log → Turso, then **catch up** log → local (not replay from seq 0 forever).

### 2.2 Thin client (cloud)

- **Already true** for `apps.papr.ai` via `/api/db/*` → `TursoDbAdapter`.
- Extend to: cloud agent sandboxes, papr-dev-platform web editor, future mobile.
- Read: Turso SELECT (row-capped) + 10s result cache + version invalidation.
- Write: log append → Turso apply; bust cache.
- **Never** `pullLinkedSourceFromCloud` full materialize on cold start.

### 2.3 When to pick mode (smart default)

| Client | Default mode | Override |
|--------|--------------|----------|
| Desktop, DB &lt; threshold (e.g. 50MB) | Full | User: "thin mode" / large DB flag |
| Desktop, DB ≥ threshold | Thin (Turso direct + optional lazy cache) | — |
| Cloud app host | Thin | — |
| Cloud agent sandbox | Thin | — |
| Mobile (future) | Thin | — |

---

## 3. Authority model: cloud on vs cloud off

### 3.1 Cloud sync **disabled** (offline namespace)

| Layer | Authority |
|-------|-----------|
| Rows | Local SQLite |
| Schema | Local `migrations/` apply on job run / agent |
| Code | Local filesystem |
| Turso | Not linked |

**Flip to cloud enabled** (one-time cutover per DB):

1. Ensure Turso replica exists (create if needed).
2. Apply pending local migrations to local SQLite.
3. Ship all local `_papr_sync_log` + schema drift-heal → workspace log → Turso.
4. Write **genesis** entry (hash of Turso/local fingerprints).
5. Mark pre-genesis seq materialized; cursor = `genesisSeq`.
6. From then on: **Turso-first** for row authority (see §3.2).

### 3.2 Cloud sync **enabled**

| Layer | Authority | Desktop behavior |
|-------|-----------|------------------|
| **Rows** | Turso (via log) | Write: local-first UX → CDC → log → Turso; read: local cache, refresh from log catch-up |
| **Schema** | Git migration files + log schema events | Drift-heal ships migrations via log; **no** direct `applyLocalMigrationsForApp` on linked DBs |
| **Code** | Per-app repo (writer ops) | Desktop POST ops; never git push |

**Cloud-first row path (target):**

```
Write request
  → append workspace log (memory assigns seq)
  → memory applies to Turso
  → notify replicas
  → desktop materializes new entries into local cache (async)
```

Local SQLite on desktop becomes **write-through cache** for responsiveness, not conflict authority. LWW/HLC on log resolves multi-writer conflicts; Turso holds result.

**Read path:**

- **Cloud:** Turso direct (+ cache).
- **Desktop:** Local SQLite if fresh enough; optional Turso fallback for thin mode or explicit "refresh from cloud".

### 3.3 Owner creates DB on web/mobile, then opens desktop

Recommended flow (cloud-enabled namespace):

1. Web/mobile writes go **directly to Turso** (thin) — already the cloud host path.
2. Owner opens desktop → linked DB exists in registry but local file empty/missing.
3. Desktop detects empty local + cloud enabled:
   - **Option A (preferred for large DBs):** Thin mode — no bootstrap; desktop uses Turso for reads, lazy local cache optional.
   - **Option B (small DBs):** One-time bootstrap from Turso → local SQLite, then genesis cursor jump (skip replaying pre-genesis log).
4. Schema ledger aligned from git migrations in app repo (not from replaying stale log DDL).

No assumption that "creator always had local DB first."

### 3.4 Cloud sync **turned off** after Turso was authoritative

Typical case: owner created data on mobile/web (Turso-first), used desktop with bootstrap cache, then disables cloud sync in Settings — or goes offline for a long stretch.

#### While cloud sync is off

| Layer | Behavior |
|-------|----------|
| **Reads** | Local SQLite only — last materialized cache (may be stale vs Turso) |
| **Writes** | Local SQLite only; CDC appends to local `_papr_sync_log` |
| **Turso / log** | No push; other team members / devices continue syncing normally |
| **Schema** | Local migrations allowed again (offline mode) — creates drift risk until reconnect |

User experience: "I'm working offline on my copy." Same as git offline — local edits queue up.

#### When cloud sync turns back on (reconnect)

Ordered merge — **pull before push** (SYNC_CONTRACT §4):

```
1. Align schema ledger (git migrations + drift-heal if local schema diverged)
2. Catch up workspace log → apply to local SQLite (LWW per row)
   → Brings in everyone else's changes while you were offline
3. Ship local _papr_sync_log since last successful push → log → Turso
   → Your offline writes compete via LWW (_papr_row_version, then _papr_updated_at)
4. Catch up again (tail any ops appended during your push)
5. Refresh genesis cursor if cutover completed while away
```

**Conflict rule (default `bidirectional`):** higher `_papr_row_version` wins; tie-break on `_papr_updated_at`. Losing writes remain in the log (auditable); UI may surface "N rows overwritten by cloud" when losses occur.

**Not:** silent full-table overwrite of local or remote. **Not:** replay from seq 0.

#### Multi-device timeline example

```
T0  Mobile writes row A (v=1) → Turso
T1  Desktop bootstraps; has A (v=1)
T2  Desktop cloud sync OFF
T3  Web collaborator updates A (v=2) → Turso
T4  Desktop offline edits A (v=2 local) and inserts B
T5  Desktop cloud sync ON
    → Pull: apply web's A (v=2) — overwrites desktop's stale A if versions compare
    → Push: B inserts; A conflict resolved by version compare
```

If desktop's offline A bump used local version without seeing v=2, LWW picks the higher version after merge. Product may add conflict review for high-stakes tables later; v1 is automatic LWW.

#### Schema while offline

If offline desktop applies migration `0006` locally but owner never merged it to git:

- Reconnect: drift detected → block row push until schema converges (PR merge or revert local migration).
- Prevents "local column exists, Turso doesn't" silent failures.

#### Thin clients (mobile/web) when "cloud off"

Mobile/web **requires** network for Turso — disabling cloud sync on desktop does not affect them. They keep using Turso. Only the device that turned cloud off works on local cache.

---

## 4. Genesis, bootstrap, and compaction

### 4.1 Definitions (do not conflate)

| Term | What it is | Turso row cost | Frequency |
|------|------------|----------------|-----------|
| **Log append** | Single row/schema delta | Low (one op) | Every write |
| **Genesis marker** | Hash fingerprint + seq in log | ~Free | Once per replica cutover; rare re-genesis on repair |
| **Bootstrap** | Full table copy Turso → local SQLite | **High** (all rows read) | Once per **new full local replica** |
| **Compaction** | Truncate oplog below genesis watermark | Low (delete log rows) | Periodic / after major cutover |

**We do not snapshot all rows on every sync.** Genesis is a **checkpoint in the log**, not a full export.

### 4.2 Genesis cutover (per replica)

Already partially implemented (`workspaceLogGenesisCutover.ts`). Complete the loop:

1. Quiesce writes briefly (queue server-side).
2. Verify local and Turso fingerprints match (or bootstrap Turso from local if owner-first cutover).
3. `POST /v1/workspace/log/genesis` with `{ snapshotHash, tableCount }`.
4. Persist `genesisSeq` locally; mark seq `1..genesisSeq` materialized.
5. All peers tail only `seq > genesisSeq`.

### 4.3 Bootstrap (desktop only)

Implement `bootstrapReplicaFromTurso()`:

- Gate: `localEmpty || explicitRepairRequested` — **never** on Upload, never on cloud sandbox.
- Paginated read (existing `REMOTE_READ_CHUNK_ROWS = 2000`).
- After bootstrap: jump to genesis cursor; do not replay pre-genesis log.

### 4.4 Log compaction (memory server)

After genesis (or on schedule when log &gt; N entries):

1. Confirm all active peers have cursor ≥ genesisSeq (or force after timeout).
2. Truncate `_papr_oplog` rows with `seq ≤ genesisSeq`.
3. Keep genesis/snapshot entry as watermark.

**Effect:** Stale `person_tags` entries disappear at source; desktop never needs skip-heuristics for pre-checkpoint history.

### 4.5 Schema replay policy (post-compaction)

- Schema log entries carry `{ migrationId, contentHash }`.
- Replay: if `migrationId` in ledger → skip; else apply from **git file at hash**, not embedded stale SQL.
- Retire broad "skip missing table" except idempotent cases (`ADD COLUMN` exists, `DROP` gone).

---

## 5. Fork, collaborate, and PR scenarios

Real dev workflows split into **two different products** — do not conflate Community fork with Team collab.

### 5.1 Two fork models

| | **Community fork** (Customize / install) | **Team collab** (same org / PR workflow) |
|---|------------------------------------------|------------------------------------------|
| **Intent** | New person owns their copy | Devs contribute code back via PR |
| **Code** | Forked per-app repo → new `appId` | Same repo or fork → PR → owner merges |
| **DB ownership** | **New owner** — new `dbId`, new Turso replica | **Optional shared DB** — like sharing a `.env` `DATABASE_URL` |
| **Row data** | **Empty** Turso (seed job optional) | **Same Turso** if team opts in — not automatic |
| **Schema** | Fork owns migrations in **their** app repo (`schemaOwnerAppId` = fork app) | Migrations via **PR to schema owner** app |
| **Surface** | Community Apps catalog | Team sharing / namespace invite — **not** community default |

**Community fork = separate DB, new person is owner.** No automatic link to upstream Turso. Same as forking a GitHub repo and using your own Postgres — you run migrations, you seed data.

**Team collab = optional shared database.** Devs who want the same rows opt into a shared Turso replica (team credential / namespace ACL). Devs who want isolated data use local SQLite or per-user isolation. This is **Team sharing**, not Community install behavior.

### 5.2 Community fork (target)

| Concern | Behavior |
|---------|----------|
| **App code** | Forked repo, new app id in installer's namespace |
| **Registry** | New `dbId` registered under fork app; fork is `schemaOwnerAppId` |
| **Turso** | **New empty replica** for fork owner — no bulk copy from upstream |
| **Local SQLite** | Blank after install; migrations from fork repo; optional Turso pull if fork owner later enables cloud |
| **Upstream** | Code PRs optional (contribute-back); **no** shared data path unless user explicitly joins a team |

Matches: "I forked the template, I own my database."

### 5.3 Team collab (target)

| Concern | Behavior |
|---------|----------|
| **App code** | Writer ops or PR to owner's per-app repo |
| **Schema** | Only **schemaOwnerAppId** ships `databases/{slug}/migrations/`. Contributors open PRs; owner merge → drift-heal → log → Turso |
| **Shared DB (opt-in)** | Team setting: "Use team database" → all members link same `dbId`, same shared Turso segment (publisher user8). Like checking in `.env.example` and each dev pointing at the same Neon URL |
| **Separate DB (default for new member)** | New team member gets empty local + empty or personal Turso until they opt into shared team DB |
| **Local SQLite** | Cache of team Turso if opted in; otherwise independent |

**Not community:** `install_cloud_app` from catalog does **not** attach to publisher's Turso. Team sharing is a namespace-level feature (invite + shared db link + ACL).

### 5.4 Collaborator schema via PR (team path)

```
Contributor (fork app F)                Owner (schemaOwner app O)
        │                                        │
        │  PR: databases/{slug}/migrations/000N   │
        ├──────────────────────────────────────►│ merge via writer
        │                                        │ drift-heal → log → Turso
        │                                        │
        │  Fork F pulls code update              │ all clients see new schema
        ◄──────────────────────────────────────┤
```

**Rules:**

- Only **schemaOwnerAppId** app includes migration SQL in writer ops.
- Fork apps with same `dbId` link read/write against owner Turso; schema version gate (`requiredSchemaVersion`) blocks UI until Turso caught up.
- Contributor must not append schema log entries against owner replica directly.

### 5.5 Optional: duplicate with data

Explicit product action (not community fork, not team default):

- "Duplicate app **with data**" — one-time bootstrap upstream Turso → new `dbId`.
- Billed as bulk read; audit logged.

---

## 6. Actor matrix (target end state)

| Scenario | Code authority | Schema | Row authority | Local SQLite |
|----------|----------------|--------|---------------|--------------|
| Owner desktop (cloud on) | Writer ops | Drift-heal → log | Turso | Full cache; bootstrap if empty |
| Owner desktop (cloud off) | Local | Local migrations | **Local** (queued CDC) | Source of truth until reconnect |
| Owner reconnects cloud | Writer ops | Drift-heal first | Pull LWW → push offline ops | Cache merged |
| Owner web/mobile → desktop | Writer ops | Git migrations + log | Turso | Bootstrap or thin |
| Web visitor (apps.papr.ai) | Release pin | Remote ledger | Turso (shared/per-user) | None (thin) |
| Cloud agent sandbox | Cloned repo | Ledger align only | Turso direct | None (thin) |
| **Community fork** | Fork repo (new owner) | Fork-owned migrations | **New empty Turso** | Blank + seed job |
| **Team collab (shared DB opt-in)** | PR → owner repo | PR → schemaOwner | **Team shared Turso** | Cache of shared DB |
| **Team collab (no shared DB)** | PR → owner repo | PR → schemaOwner | Own Turso / local | Independent |
| Second owner device | Writer ops | Log + git | Turso | Bootstrap once if empty |

---

## 7. Implementation phases

### Phase 1 — Stop the bleeding (done / in progress)

- [x] P0: Skip superseded row/schema replay (triage)
- [x] P0: flushAppNow catch-up before push; no direct local migrations when cloud on
- [x] P0: Workspace log read timeout 300s
- [ ] Document and flag P0 skip as **temporary** (`SYNC_V3_REPLAY_TOLERANCE=1`)

### Phase 2 — Cloud thin (4–6 weeks)

- [ ] Remove full log materialize from `pullLinkedSourceFromCloud` / sandbox bookends
- [ ] Schema-only bookend: `alignMigrationLedgers` + genesis cursor read (no row replay)
- [ ] Agent/job Turso helper for scripts (env + `query_cloud_turso` parity with cloud host)
- [ ] Extend read micro-cache to sandbox (optional session LRU)
- [ ] Tests: sandbox cold start does zero row materialize; reads hit Turso

### Phase 3 — Desktop bootstrap + genesis (4–6 weeks)

- [ ] `bootstrapReplicaFromTurso()` with explicit gate
- [ ] Wire into: empty local pull, post-install (optional), repair action
- [ ] After bootstrap: set cursor to `genesisSeq`, mark pre-genesis materialized
- [ ] Owner-first cloud flip flow (§3.1 step 1–6)
- [ ] Memory server: genesis API returns `genesisSeq` (verify contract)
- [ ] Tests: empty local + 1M rows → bootstrap once, no log replay from seq 0

### Phase 4 — Compaction + schema replay hardening (4–6 weeks)

- [ ] Memory server: oplog compaction below genesis watermark
- [ ] Schema replay from git `contentHash` when ledger miss
- [ ] Narrow P0 skip to idempotent-only; fail loud on true drift
- [ ] Replay CI on prod samples post-compaction

### Phase 5 — Fork / team (6–8 weeks)

- [ ] **Community fork:** new `dbId` + empty Turso; fork owns `schemaOwnerAppId`; no upstream data link
- [ ] **Team sharing:** namespace setting to link members to shared `dbId` + Turso (opt-in, ACL)
- [ ] Block non-owner apps from shipping owner migration paths in writer ops
- [ ] `requiredSchemaVersion` gate on cloud host (partially designed in SYNC_CONTRACT §12)
- [ ] Contribute-back PR flow docs + UI: team schema changes require owner merge
- [ ] Optional: explicit "duplicate with data" (bulk bootstrap, billed)

### Phase 6 — Cloud-first desktop (optional, 6+ weeks)

- [ ] When cloud on: writes authoritative on Turso first (or log-first with Turso apply before ACK)
- [ ] Desktop local becomes strict cache with version checks
- [ ] Large DB auto-thin on desktop

---

## 8. Cost model (plan-level)

| Operation | Billed | When |
|-----------|--------|------|
| Steady sync | Log deltas + changed rows | Every write |
| Cloud page load | Rows returned by SELECT | Per query (cached 10s) |
| Desktop bootstrap | All rows once | New full replica only |
| Genesis/compaction | Log metadata | Rare |
| Fork default | **$0 row copy** | Uses shared Turso |
| Duplicate-with-data | Full row read | Explicit opt-in only |

---

## 9. Open decisions (need product input)

1. **Desktop default when cloud on:** Always bootstrap small DBs locally, or Turso-thin until user opts into offline cache?
2. **Team shared DB:** Read/write for all invited members, or role-gated (viewer vs editor)?
3. **Offline conflict UI:** Silent LWW vs banner when reconnect loses local rows?
4. **Collaborator without Papr login:** Shared link apps only, or anonymous write via share token?
5. **Mobile:** Thin-only at launch, or offline cache for signed-in owner?
6. **Compaction cadence:** After every genesis, or when log &gt; 50k entries?

---

## 10. Success criteria

- Upload never replays unbounded pre-rename history on established DBs.
- Cloud sandbox start &lt; 5s with zero full-table reads.
- New desktop device: bootstrap once OR thin mode — never silent skip of row ops.
- Community fork: new owner, empty Turso, no upstream data coupling.
- Team collab: shared DB is opt-in team feature; schema via PR to schemaOwner.
- P0 skip-heuristics removed or reduced to idempotent DDL only after Phase 4.
- Turso row billing scales with **activity**, not **database size**, for cloud and fork paths.

---

## Related files

| Area | Files |
|------|-------|
| Genesis | `workspaceLogGenesisCutover.ts`, `WorkspaceLogClient.ts` |
| Materializer | `LogMaterializer.ts`, `migrationSchemaLocal.ts` |
| Cloud thin | `TursoDbAdapter.ts`, `dbRequestGuard.ts`, `CloudAppHostService.ts` |
| Sandbox bookends | `syncJobTursoBookends.ts`, `cloudAgentRunContext.ts` |
| Fork install | `cloudAppInstallBootstrap.ts`, `CloudAppInstallService.ts` |
| Schema owner | `DatabaseRegistryService.ts`, `collectAppOpFiles.ts` |
| Contribute PR | `contributeDataIndexMerge.ts`, `namespaceGitReview.ts` |
