# Paprwork Sync V3 — Target Architecture

**Status:** Converged design (2026-08-18). Supersedes the first draft (custom blob store, cloud-first jobs). **GitHub stays; jobs stay local-first.**

**Goal:** Replace ~37k lines of state-comparison sync with a small set of single-writer primitives that scale to 100M+ users and their apps.

**Companion docs:**

- [`SYNC_CONTRACT.md`](./SYNC_CONTRACT.md) — binding behavioral contract (frozen app-facing APIs)
- [`SYNC_V3_IMPLEMENTATION_PLAN.md`](./SYNC_V3_IMPLEMENTATION_PLAN.md) — phased implementation against this repo
- [`SYNC_ARCHITECTURE_V2.md`](./SYNC_ARCHITECTURE_V2.md) — historical V2 plan (superseded for new work)

**Evidence / audit:** *Paprwork V2 Sync Architecture Audit — Synthesis* (patch tax, bug catalog)

---

## Design principles

1. **One mover per source of truth.** Ship context with every change; never reconstruct it after the fact. Today's 37k lines exist because N processes push the same git repo and write the same rows, and downstream code (verify/reconcile/hygiene/drift-repair) infers *what happened* by comparing states. Make concurrent divergent writes unrepresentable where possible; detect the rest at write time with certainty.

2. **Smart defaults, zero decisions for non-technical users.** Nobody chooses sync modes, replica modes, or execution placement — the system picks (replica mode by DB size, executor by job capability + desktop health, scheduling by whether a schedule exists). Advanced users get overrides (`runtime: cloud` pin, app-declared thin mode). Any surfaced options must be *clearly different* — never "local preferred" vs "cloud ok" ambiguity.

3. **Multi-client from day one.** papr-dev-platform (web) already replicates the desktop experience; mobile is coming. Desktop, cloud sandbox, web editor, and mobile are all clients of the same three interfaces — **POST ops to the writer, consume the log, call dispatch**. Nothing may assume "the desktop" is special except as the preferred job executor.

---

## 1. Code: per-app GitHub repos + `app-repo-writer` service

**GitHub remains the source of truth and blob store** — git's object DB *is* the blob store; no custom object store.

### Three structural changes

1. **Per-app repos** (not one namespace repo). App B's activity can never make app A's remote "ahead." Enables native GitHub forks for contribute-back, kills cross-app push contention, makes writer sharding embarrassingly parallel.

2. **No runtime metadata in git** — job runtime is always off git; delete legacy reconcile paths. Machines stop generating the commits that raced human pushes.

3. **One pusher:** `app-repo-writer` — a small separate Cloud Run service (peer of `cloud-app-host` and `cloud-agent-gateway`; **not** inside the memory server). It is the *only* process that moves `main` on any app repo.

### How a save flows

Desktop and cloud sandbox use the identical path:

```
file saved → watcher debounces →
POST https://sync.papr.ai/apps/{appId}/ops
  { files: [{ path, content, parentHash }], author, message }
→ writer: per-app mutex → compare parentHash to HEAD blob OID per path
    match    → write files, git commit, git push, notify replicas
    mismatch → conflict artifact + UI event; human resolves
```

- **Clients never run git** (no fetch/rebase/push credentials on devices).
- **Ops carry whole file contents**; git computes deltas. `parentHash` = **git blob OID** at last sync (`git hash-object` — desktop uses local git subprocess, not WASM).
- **"Main is ahead" is impossible by construction** — nobody else moves the ref.
- **Contribute-back:** fork → PR → webhook → writer ingests merge commit.
- **Sandboxes:** shallow-clone one app repo; edits flow back as ops through the writer.
- **253 GB class:** writer enforces op size limits and binary rejection *before* git.
- **Scope:** ~2,000–3,000 LOC production-grade for the writer service.

### Per-app repo layout (Phase 4)

Each app GitHub repo ships **code only** — runtime metadata and row data stay out of git:

```
{app-repo}/
  metadata.json, index.html, …     # mini-app source (repo root)
  jobs/{jobId}/                    # linked job definition + code (config-only job.json)
  databases/{slug}/migrations/     # ONLY when this app is schemaOwnerAppId for dbId
```

| Bucket | Authority |
| --- | --- |
| App + linked job code + owner migration `.sql` | Per-app repo via **app-repo-writer ops** |
| `jobs.json` / `databases.json` metadata | Namespace git today → **Mongo** (Phase 4b) |
| Row data | **Workspace log** → Turso + local SQLite materializer |
| Job runtime (`status`, `lastRunAt`, …) | **Mongo** + heartbeat |

**Shared DB rule:** one `schemaOwnerAppId` per `dbId`. Consumer apps link via `dbId` only — they do not ship duplicate migration files. Non-owner apps must not include `databases/{slug}/migrations/` in writer ops.

**Cloud note:** Memory server reads linked job code from the app shard repo at `jobs/{id}/` (with legacy fallback to namespace `Jobs/{id}/`). Mini-app runtime files are served from the app repo root when registered.

---

### 1.1 GitHub at scale: org sharding behind the writer

- **Papr-owned org pool**, sharded (~tens of thousands of repos per org), **not** org-per-namespace.
- **Lazy create** via API; **delete** repo on app delete (archive does not free quota).
- Open new shard org when any shard approaches ~80k repos (GitHub hard cap 100k).
- Queue repo creates at ~1 req/s for secondary rate limits.
- **Server-side** `appId → org/repo` shard registry. Clients never construct repo URLs.
- Rate limits are per GitHub App installation per org → sharding multiplies API budget.
- **Insurance property:** the writer is the single seam where a different storage backend could slot in — no client would notice.

---

## 2. Data: ordered workspace log; SQLite and Turso as replicas

One append-only log per workspace orders stateful changes: row ops, schema-apply events (v1); job-status and publish events join in later phases.

- **Sync = ship missing entries** from a known position. Delta cost ∝ changes, never ∝ total data.
- **Append authority:** only the **memory server** appends to the log. Clients POST row ops; server assigns `(replica_id, seq)` + HLC. Turso holds the durable log; SQLite is a materialized replica.
- **Conflicts:** default LWW by HLC; losing write preserved in the log (auditable). Tables ending in `_events` / `_log` are **append-only** in v1.
- **Replica modes:** full local (default, small DBs) vs thin (large DBs / phones — `/api/db/*` to Turso, log-first writes).
- **Recovery = re-materialize from log**, never overwrite a peer.

### 2.1 Log v1 scope (deliberately narrow)

- **Row ops + schema events only.** Job-status → Phase 4 dispatch channel. Publish → Phase 5 releases.
- **LWW-by-HLC only**, plus append-only convention for `*_events` / `*_log` tables.
- **Storage:** `_papr_oplog` table in each workspace's existing Turso database. Compaction = snapshot entry + truncate below watermark.
- **CI replay determinism test from day one:** genesis → append N ops → materialize → byte-compare. No fingerprint deletion until this passes on real captured workloads.

---

## 3. Migrations: file in git, application in the log

- Migration **`.sql` file is code** → flows through the writer like any file.
- **Applying it is an event** → `schema` log entry `{ db, migrationId, contentHash }`. Replicas apply in log order. Row entries follow schema entries they depend on.

---

## 4. Job execution: local-first, cloud for reliability

- **`local-only`** — desktop only; visible "Waiting for your Mac" when unavailable.
- **`cloud-capable`** (default) — prefers desktop; cloud fallback when asleep, loaded, or `runtime: cloud` pin.

**Dispatch:** push over live channel (not `pendingCloudRuns` + 60s heartbeat poll). One-off runs never touch the scheduler. **Server-authoritative scheduler** for cron/interval — same local-first dispatch path.

**Operational note:** scheduler SLO matches product promise; missed-fire = alert, not silence.

**No degraded-mode dual scheduler in v1.** If the server is unreachable, local-only scheduled jobs catch up on reconnect via server `catchUpMissed` — desktop does not maintain a parallel firing authority.

---

## 5. Publish/install: immutable releases

Publish = immutable release: git tag/commit + manifest declaring job/DB links in metadata (no UUID-regex forensics). Install = fetch release + transactional apply.

### 5.1 cloud-app-host becomes a release consumer

| Today | V3 |
| --- | --- |
| Fire-and-forget revision notify → pull repo | Subscribe to writer/release feed; resumable cursor |
| Full apps-directory walk | Materialized index from release entries — O(changes) |
| Serve HEAD | Serve **pinned release commit** only |
| `/api/db/*` proxied to Turso | Same contract; backend = log-consuming replica (thin mode) |

---

## 6. Converged stack

| Piece | Role |
| --- | --- |
| Per-app GitHub repo | Source of truth for code + migration files |
| `app-repo-writer` (Cloud Run) | Sole pusher; parentHash check → commit → notify (~2–3k LOC) |
| Desktop / sandbox / web / mobile | POST ops, consume log/notifications; **never run git** |
| Workspace log (`_papr_oplog`) | Rows + schema (v1); HLC + LWW |
| Local SQLite / Turso | Materialized replicas — full or thin |
| Memory server | Auth, ACL, **log append authority**, scheduler, dispatch |
| Desktop executor | Preferred runtime; health in dispatch acks |
| cloud-agent-gateway | Agent jobs + cloud-fallback workers |
| cloud-app-host | Pinned release serving; release-feed subscriber |

---

## 7. Migration path (phases independently shippable)

See [`SYNC_V3_IMPLEMENTATION_PLAN.md`](./SYNC_V3_IMPLEMENTATION_PLAN.md) for file-level detail.

1. Per-app repos + RepoRegistry (runtime always off git)
2. `app-repo-writer`; desktops stop pushing
3. Log v1 (rows + schema)
4. Local-first dispatch + server scheduler
5. Releases + cloud-app-host cutover

**Stakeholder framing:** Phases 1–2 (~16 weeks) fix the dominant push-conflict / "remote is ahead" class. Phases 3–5 (~26 weeks) are structural (log, dispatch, releases). The full arc is ~42 weeks — believed, not hedged, because launch is single-version (§8.6).

---

## 8. Migration safety

### 8.1 Three populations, three upgrade speeds

| Population | Can we change it? | Speed |
| --- | --- | --- |
| Cloud services | Yes, atomically | Instant |
| Desktop app binary | Yes, via auto-update | Weeks of stragglers |
| User artifacts (mini-app code, jobs, SQLite) | **Never** | Frozen forever |

### 8.2 Invariant: the app-facing contract is frozen

User apps and jobs speak only:

- `/api/db/query`, `/api/db/write`, `/api/db/exec`, `/api/db/batch`
- `/api/jobs/run`, job-events subscription
- `$APP_DB` / `PAPR_DB_*` in jobs
- `/api/access`, key-vault, app-agent endpoints

**CI contract tests pin every shape.** The V3 rewrite happens underneath.

### 8.3 Straggler protocol: capability handshake + shadow mode

1. Clients report `syncProtocol: v2 | v3` on connect.
2. **Shadow mode (per namespace):** writer deployed; v2 clients may still git-push to **per-app repos** (Phase 1 must complete before Phase 2 shadow).
3. **Cutover (per namespace):** all clients v3 → branch protection → writer sole pusher.
4. **Hard floor:** minimum desktop version retires v2 after measurement, not calendar.

**Shadow-mode hard invariants:**

- Metrics: `v2_direct_push_count`, `v3_op_count`, conflict rate
- **Auto-rollback:** v2 direct push after cutover → flip namespace back to shadow + alert
- Writer **rejects ops** whose `parentHash` is not reachable from current HEAD

### 8.4 Repo split without touching devices

Server-side `git filter-repo` split; namespace repo archived read-only. Local paths unchanged (`$PAPR_HOME/apps/{id}/…`). Mapping table server-side only.

### 8.5 Data migration: log starts from snapshot

Quiesce writes (seconds) — **queue incoming writes server-side**, replay after genesis. Snapshot → genesis entry → all replicas verify hash → flip per DB. Failed migration leaves old path working.

### 8.6 Single launch, staged cutover

**One software version ships to main continuously; there is no global flip day and no long-lived V3 mega-branch.**

| Principle | Meaning |
| --- | --- |
| **Dark-launch to main** | V3 code lands behind per-namespace / per-DB flags on main; flags are build gates with owners and deletion criteria — they die before public launch, not after. |
| **Staged cutover** | Each namespace (and each database for log mode) cuts over independently when its exit gates pass — not all users at once. |
| **Phase exit gates stay internal** | Phases 0–5 retain measurable deletion criteria even though users see one product version. |
| **Shadow at launch still required** | Desktop stragglers exist regardless of launch strategy; auto-rollback metrics activate at launch. |

**Policy decisions (resolve early with team):**

1. **V2 freeze policy** — What severity of sync bug gets patched in code scheduled for deletion during the ~42-week build? Decide now to avoid relitigating under incident pressure.

2. **Dogfood window** — Papr's own namespaces on full V3 for the final stretch before general availability. If the schedule slips, dogfood must not get squeezed.

### 8.7 Rollout order

- New namespaces first (pure V3 from day one)
- Internal/dogfood → cohorts (smallest/least-active first)
- Every flag defaults off with tested rollback
- **Success metric = deletion** of legacy code, not merely shipping new code
