# Architecture Conversation Synthesis

Simple reference for everything discussed across the sync audit, cloud runtime, mini-app access, Turso, vault, and user-identity threads.

**Last updated:** 2026-08-21

**Related binding docs:** [`SYNC_CONTRACT.md`](./SYNC_CONTRACT.md) · [`SYNC_ARCHITECTURE_V3.md`](./SYNC_ARCHITECTURE_V3.md) · [`SYNC_V3_IMPLEMENTATION_PLAN.md`](./SYNC_V3_IMPLEMENTATION_PLAN.md)

---

## TL;DR

| Topic | One line |
|-------|----------|
| **Three layers** | Publish ACL ≠ Turso replica ≠ row-level SQL filtering — don't conflate |
| **Shared Turso DB** | One replica per **app owner**; all team visitors read/write the **same** cloud DB |
| **Per-user Turso DB** | Separate replica per **caller** (`d-{db8}-u-{user8}`) — **fixed in cloud host** via `tursoRuntimeIdentity.ts` |
| **Row privacy in shared DB** | **Not platform-enforced** — app must filter on `papr_user_id` from `/api/access` **caller `userId`** |
| **`/api/access`** | **`userId` = caller**; **`publisherUserId` = catalog owner**; **`isOwner`** = caller === publisher (or mode owner) |
| **`owner_session`** | Client UUID in `localStorage` — UX isolation, not strong security |
| **Vault** | Owner-scoped keys = **publisher's** vault; user-scoped = **caller's** vault (sign-in required) |
| **Desktop agent `query_cloud_turso`** | Uses **caller's** namespace key + `external_user_id` → **caller's** replica, **not** owner's shared team DB |
| **Memory API** | `external_user_id` only today → **chat message sync** likely creates most shadow `DeveloperUser` rows |
| **Cloud `external_user_id`** | **Passthrough Parse objectId** — works for Paprwork but **wrong field name** for third-party devs |
| **Identity backfill** | Fixing DeveloperUser alone is **not enough** — need Parse + Neo4j + Qdrant re-key for old anon data |

---

## 1. Three separate layers (do not mix)

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: PUBLISH / APP ACL                                 │
│  Who may open app on apps.papr.ai? (team, link, public)     │
│  GET /api/access → canRead, canWrite, isOwner (UI hint)     │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: TURSO REPLICA SELECTION                           │
│  Which physical DB file? p-{org8}-{ns8}-{user8}-{shortName}   │
│  shared registry → owner's user8; per-user → caller's user8  │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: ROW-LEVEL FILTERING (app responsibility)          │
│  Inside a shared DB: SELECT * returns ALL rows              │
│  App adds papr_user_id, owner_session, RLS in SQL, etc.     │
│  Platform does NOT filter /api/db/query or /api/db/write      │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Actors & where they write

| Actor | Code (git) | Rows (Turso) | Publish catalog |
|-------|--------------|--------------|-----------------|
| **Desktop (gateway)** | Primary publisher | Push via workspace log | Auto/manual publish |
| **Web visitor (apps.papr.ai)** | Read-only | **Default: can write** (`bidirectional`) | N/A |
| **Cloud agent sandbox** | Pull/push during run | Writes during run | N/A |
| **Other desktop (same namespace)** | Pull; owner review on conflict | Same as desktop | N/A |

Default: **`writeAuthority` absent = `bidirectional`** — web forms and `/api/db/write` must keep working.

---

## 3. Mini-app access on `apps.papr.ai`

### Auth inputs

| Credential | Who it identifies | Used for |
|------------|-------------------|----------|
| **Session cookie** (`papr_session`) | Logged-in Parse user (caller) | Primary web auth |
| **Share token** (header/cookie) | Link visitor | `link_read` / `link_read_write` |
| **Visitor API key** (optional) | Enrichment | Namespace keys via GraphQL |
| **Host key** (`PAPR_CLOUD_APP_HOST_KEY`) | Cloud app host → memory server | Server-to-server only |

### Access validate flow

```
Browser → Cloud App Host → POST /v1/cloud/apps/access/validate
         (namespaceId, slug, session, shareToken, external_user_id)
                              ↓
         Memory checks publish doc + caller namespace ACL
                              ↓
         Returns: orgId, namespaceId, userId, appId, mode, canRead, canWrite
```

**Important:** Memory validate response `userId` is still the **publisher's** Parse id (from publish catalog). Caller identity is passed **in** as `external_user_id` / session — not returned as a separate field from memory validate.

### GET `/api/access` (mini-app UI) — **updated 2026-08-21**

Returns `mode`, `canRead`, `canWrite`, `loggedIn`, `isOwner`, and when signed in:

| Field | Meaning | Notes |
|-------|---------|-------|
| **`userId`** | **Caller's** Parse objectId | Use for row filters (`papr_user_id`), vault user scope |
| **`externalUserId`** | Same as `userId` | Mirrors cloud API naming |
| **`publisherUserId`** | Publish-catalog owner | Admin UI, shared Turso segment, owner vault |
| **`email`** | Session email | Display / app-level filtering |
| **`isOwner`** | Caller is publisher (or `mode === "owner"`) | `resolveIsOwner()` compares caller to `access.userId` |

Implemented in `miniAppAccess.ts` → `buildMiniAppAccessResponse`; wired from `CloudAppHostService.handleAccess` with session `externalUserId`.

**Desktop Paprwork iframe:** always `mode: owner`, full read/write (`buildLocalDesktopAccessResponse`).

### Job params (verified caller) — **landed**

When logged in on cloud app host, server injects into job env (overrides client):

- `PAPR_CALLER_USER_ID`
- `PAPR_CALLER_EMAIL`

See `miniAppAccess.ts` → `mergeVerifiedCallerJobParams`; used in `CloudAppHostService` job run handler.

---

## 4. Turso: shared vs per-user

Registry field: `databases.json` → `isolation: "shared" | "per-user"`.

| Isolation | Turso short name | Whose `user8` in full name | Who sees same data |
|-----------|------------------|----------------------------|--------------------|
| **`shared`** (default) | `d-{db8}` or `j-{job8}` | **App owner's** (publisher) | Everyone with `canRead` on the app |
| **`per-user`** | `d-{db8}-u-{caller8}` | **Each caller's** Parse id | Only that user |

Full name pattern: `p-{org8}-{ns8}-{user8}-{shortName}` (`tursoDatabaseNaming.ts`).

**Desktop sync push** uses acting user's key + `external_user_id` → owner's or caller's segment depending on isolation.

**Web `/api/db/*` (fixed):** `CloudAppHostService.tursoDbRequest()` passes `{ userId: publisher, callerUserId: session }` into `TursoDbAdapter`. `tursoRuntimeIdentity.ts` picks segment:

```
shared   → publisherUserId
per-user → callerUserId (throws if unsigned)
```

Per-user sources without sign-in are blocked at access/schema gate (`cloudAppPerUserAccess.ts`).

---

## 5. Owner vs caller — who we use when

| Operation | Should use | Status (2026-08-21) |
|-----------|------------|---------------------|
| **Publish ACL check** | Caller session + namespace ACL | ✅ Caller via session |
| **Shared Turso read/write (web)** | **Owner's** replica | ✅ `resolveTursoActingUserId("shared")` |
| **Per-user Turso read/write (web)** | **Caller's** replica | ✅ **Fixed** — `tursoRuntimeIdentity.ts` |
| **Turso token (desktop sync)** | Acting user (`external_user_id`) | ✅ |
| **Vault: owner-scoped keys** | **Publisher's** vault | ✅ |
| **Vault: user-scoped keys** | **Caller's** vault (sign-in required) | ✅ |
| **GitHub repo file fetch (runtime)** | **Publisher's** repo | ✅ |
| **Jobs list/status (cloud runtime)** | **Publisher's** workspace | ✅ |
| **GET `/api/access` `userId`** | **Caller's** id for app filtering | ✅ **Fixed** — separate `publisherUserId` |
| **Cloud job run params** | Verified caller injected | ✅ `PAPR_CALLER_*` |
| **Desktop `query_cloud_turso`** | Caller's replica via namespace key | ✅ Caller's segment (not owner's shared DB) |
| **Desktop bash `sqlite3`** | Local file on disk | No cloud ACL |
| **Memory add/search/messages** | Real Parse `_User` (first-party) | ❌ Still shadow path — see §9 |

---

## 6. Credentials cheat sheet

### Paprwork desktop (logged in)

| Secret | Scope | Used for |
|--------|-------|----------|
| **`PAPR_API_KEY`** | Namespace (org owner as `developer_id` on server) | Memory, cloud `/v1/cloud/*`, Turso token, sync |
| **`external_user_id`** | Parse objectId of **logged-in user** | Acting user for cloud + memory |
| **`PAPR_SESSION_TOKEN`** | User session | GraphQL, workspace members, some IPC |
| **Custom keys / vault** | Per-user or org keychain | Bash, jobs, mini-apps via substitution |

Namespace API key authenticates the **namespace**; `external_user_id` selects **who is acting** (Turso segment, cloud ownership).

### ⚠️ Cloud routes: `external_user_id` is really `user_id` (API design bug)

Paprwork sends **Parse `_User.objectId`** in the field named `external_user_id` on all `/v1/cloud/*` calls (`cloudActingUser.ts`). Memory cloud handler **does not resolve** it like the Memory add/search path:

```python
# memory/services/cloud_acting_user.py
async def resolve_cloud_acting_user_id(..., external_user_id):
    # Passthrough: treats string as Parse objectId directly
    return acting  # no DeveloperUser lookup
```

| API surface | What `external_user_id` means | Resolution |
|-------------|------------------------------|------------|
| **`/v1/cloud/*`** | **Must be Parse objectId** | Passthrough + namespace ACL check |
| **`/v1/memory/*`, messages** | Developer's opaque external id | `DeveloperUser` lookup → may create `anon_*` shadow |

**Why Paprwork works:** we put our real Parse id in `external_user_id`, so cloud Turso/publish/vault get the correct user segment.

**Why third-party devs break:** if a developer sends *their* internal user id (e.g. `"customer_4829"`) on cloud routes, the server treats that string as a **Parse objectId** — ACL checks and Turso `{user8}` segments will be wrong. On Memory routes the same string would correctly go through `DeveloperUser` resolution.

**Correct long-term fix (Memory server):**

- Cloud routes should accept **`user_id`** (Parse objectId) for first-party / known internal users
- Reserve **`external_user_id`** for third-party opaque ids with DeveloperUser mapping
- Or document cloud `external_user_id` as “Parse objectId only” and rename Paprwork client field to `user_id`

Until then: **field name implies Memory semantics; cloud semantics differ** — a footgun for API consumers.

### Web mini-app visitor

| Secret | Scope |
|--------|-------|
| Session | Caller |
| Share token | Link access only |
| Vault user keys | Caller (must sign in) |
| Vault owner keys | Publisher (server resolves) |

### Cloud app host → memory

Uses **`PAPR_CLOUD_APP_HOST_KEY`** (service account), not the visitor's key. Memory validates publish ACL then issues **publisher-scoped** runtime credentials (Turso, repo) — visitor identity passed separately for ACL + user vault.

---

## 7. Row-level ACL — what developers must do

Platform **`/api/db/query`**, **`/api/db/write`**, **`/api/db/exec`**:

- Enforce statement type, rate limits, row caps, replica allowlist
- **Do not** enforce `WHERE papr_user_id = ?` on behalf of the app

So for **shared** team databases:

1. App reads **`/api/access`** → get server-resolved `userId` + `email` (when fixed: **caller** id)
2. App stores **`papr_user_id`** (or similar) on insert
3. App filters **`WHERE papr_user_id = ?`** on read
4. Optional client **`owner_session`** UUID for browser-profile UX — not a security boundary on `public_read`

For **per-user** isolation at the **DB file** level: set registry `isolation: "per-user"` — platform routes to separate Turso replicas; still no automatic row ACL inside each file.

Platform columns (sync): `_papr_created_at`, `_papr_updated_at`, `_papr_row_version` — LWW merge, **no `_papr_updated_by` in v1**.

---

## 8. Desktop agent paths

| Tool / path | Data source | Sees owner's live shared team DB? |
|-------------|-------------|-----------------------------------|
| **`query_cloud_turso`** | `/v1/cloud/databases/token` + caller `external_user_id` | **No** — caller's `{user8}` segment |
| **`get_cloud_sync_status`** | GitHub + local Turso bridge state | Status only |
| **bash `sqlite3 $PAPR_HOME/...`** | Local SQLite | Local copy (may lag cloud) |
| **Open app on apps.papr.ai (team)** | Publisher Turso scope | **Yes** — live shared replica |

Team member B asking the desktop agent to inspect **owner A's shared app DB** via `query_cloud_turso` will **not** see A's live shared replica — B gets B's token scope. B **does** see A's shared data when opening the app in the browser (team `canRead` → publisher replica).

---

## 9. User identity (Memory / signup / cloud naming)

Separate from Turso ACL — two different meanings of “external user”:

| Store | Real signup email? | Real Parse `_User`? |
|-------|--------------------|------------------------|
| Parse **`_User`** at signup | ✅ | ✅ |
| Local **`settings.paprProfile`** | ✅ | ✅ (objectId) |
| **`DeveloperUser`** (Memory auto-create) | ❌ usually | ❌ shadow `anon_*` user |
| **Cloud `/v1/cloud/*`** | N/A | ✅ caller via `external_user_id` **passthrough** (Parse id) |
| **Memory writes (today)** | Not sent | ⚠️ shadow via `external_user_id`-only path |

### What creates shadow users (volume)

Highest volume path: **`messages.store`** (chat sync) — every logged-in user, every message, via `PaprMemoryProvider` → `paprSyncPayload` (`external_user_id` only, no `user_id`).

Also: agent `memory.add` / search, code indexer, job memory sync, `POST /v1/user`.

### Resolution when anon already exists

| Client sends | Server behavior |
|--------------|-----------------|
| **`user_id` + `external_user_id`** (both = Parse idA) | Uses **idA directly** — **skips** `DeveloperUser` lookup (`resolve_end_user_id` ADD path) |
| **`external_user_id` only** | Looks up `DeveloperUser` → returns linked user (**anon idB** if row exists) |
| **`external_user_id` only**, no row | Creates new `anon_*` + `DeveloperUser` |

Sending both ids **fixes forward writes** but **does not repair** existing data keyed to idB.

### Split history risk (without backfill)

After client starts sending idA without data migration:

- Old **Chat** / **PostMessage** / **Memory** rows still point at **idB**
- New rows go to **idA** (may create duplicate `Chat` for same `sessionId`)
- Cloud history fetch + memory search filter on **idA** → old messages/memories **invisible** (not deleted)
- Desktop local SQLite still has history (local-first) — cloud/cross-device breaks

### Backfill scope (required for unified identity)

**DeveloperUser pointer fix alone is insufficient.** Full migration per `(developer_id, namespace_id)`:

| Tier | Classes / stores | Fields |
|------|------------------|--------|
| **Parse** | `DeveloperUser` | `user` pointer idB → idA; dedupe rows |
| **Parse** | `Chat`, `PostMessage`, `Memory`, `Post` | `user`, `userTo`, `user_read_access`, `user_write_access`, ACL, `metadata.user_id` |
| **Neo4j** | Memory graph nodes | `user_id`, `user_read_access`, `user_write_access` |
| **Qdrant** | Vector payloads | `user_id`, `user_ids`, ACL arrays in payload |

Optional transition: dual-read alias map (search matches idA **or** legacy idB) during backfill.

**Client fix (Paprwork, not yet landed):** send **`user_id` + `external_user_id`** (same Parse objectId) on all Memory/message writes — **after** Parse backfill, or accept split.

See also: [`USER_IDENTITY_AND_OPEN_ITEMS.md`](./USER_IDENTITY_AND_OPEN_ITEMS.md)

---

## 10. Sync V3 context (brief)

**Problem:** ~37k LOC of state-comparison sync; high fix-commit ratio.

**Direction (V3):**

| Bucket | Authority |
|--------|-----------|
| **Code** | Per-app GitHub repo via writer ops |
| **Metadata** | Mongo (jobs/catalog/registry) — off namespace git |
| **Row data** | Workspace log → Turso (+ local materializer) |

**Principles:** one mover per source of truth; routine row sync is log-only; “synced” must be earned.

**Status:** Phases 0–4 largely implemented locally; writer + workspace log deployed in dev; genesis cutover, orphan DB cleanup done in sessions. See implementation plan for phase exit criteria.

---

## 11. Implementation status & open items

### ✅ Landed in Paprwork (this branch / recent sessions)

| Item | Files | Notes |
|------|-------|-------|
| **Caller vs publisher on `/api/access`** | `miniAppAccess.ts`, `CloudAppHostService.handleAccess` | `userId` = caller; `publisherUserId` separate |
| **`isOwner` semantics** | `miniAppAccess.ts` `resolveIsOwner()` | Team member: caller === publisher; desktop: always owner |
| **Per-user Turso replica resolution (web)** | `tursoRuntimeIdentity.ts`, `TursoDbAdapter.ts`, `CloudAppHostService.tursoDbRequest` | Shared → publisher; per-user → caller |
| **Per-user sign-in gate** | `cloudAppPerUserAccess.ts`, schema gate | Unsigned visitors blocked when linked per-user sources |
| **Job caller injection** | `mergeVerifiedCallerJobParams` in job run handler | `PAPR_CALLER_USER_ID`, `PAPR_CALLER_EMAIL` |
| **Tests** | `tests/mini-app-access-api.test.ts`, `tests/turso-runtime-identity.test.ts` | Caller/publisher split + Turso acting user |

### P0 — Wrong data / identity (still open)

| # | Item | Where | Notes |
|---|------|-------|-------|
| P0-1 | **Memory shadow users + split history** | Paprwork → Memory API | Send `user_id` + `external_user_id`; **full backfill** Parse + Neo4j + Qdrant before/alongside client fix |
| P0-2 | **Cloud API field naming** | Memory `cloud_acting_user.py` + Paprwork `cloudActingUser.ts` | Cloud treats `external_user_id` as Parse id; breaks third-party devs — add `user_id` on cloud routes or rename/document |
| P0-3 | **Prod workspace log 500** (`namespace_id` None) | Memory server | Fix deployed locally; **needs prod deploy** |

### P1 — Memory server / product

| # | Item | Where | Notes |
|---|------|-------|-------|
| P1-1 | **Memory resolver may ignore top-level `external_user_id`** | Memory `_resolve_user_for_memory_parallel_v2` | Search copies request fields; memory path may not — verify parity |
| P1-2 | **DeveloperUser relink + data migration script** | Memory / Parse ops | Batch: idB → idA across Chat, PostMessage, Memory, Post, Neo4j, Qdrant |
| P1-3 | **Dual-read during migration** | Memory search | Match idA or legacy idB alias while backfill runs |

### P2 — Product / guardrails

| # | Item | Where | Notes |
|---|------|-------|-------|
| P2-1 | **Publish guard: per-user DB ⇒ require sign-in** | Publish UI + validation | Partial — `coerceRequireSignInForPerUserIsolation` exists; verify UI |
| P2-2 | **Document app pattern for shared DB row ACL** | Agent docs | `/api/access` → `userId` (caller) → filter `papr_user_id` |
| P2-3 | **Agent guidance: `query_cloud_turso` ≠ team shared live DB** | System prompt / cloud tools | Use web app for owner's shared replica |
| P2-4 | **Turso “Synced” false positive** | `tursoSyncStatus.ts` | Fingerprint-aware dirty detection (partial fix landed) |
| P2-5 | **Cloud sync initial clone data loss** | `CloudSyncService.initialClone` | Checkout + mass-deletion guard (fix landed; verify) |

### P3 — Optional / audit

| # | Item | Where | Notes |
|---|------|-------|-------|
| P3-1 | **Store caller on workspace log / oplog payload** | Memory + host | Audit who wrote each row op |
| P3-2 | **`_papr_updated_by` column** | Sync contract v2 | When audit / owner-wins ties needed |
| P3-3 | **Cross-namespace DeveloperUser linking** | Memory server | No email-based merge today |

### ~~Closed (was open)~~

| Former item | Resolution |
|-------------|------------|
| P0-1 Per-user Turso on web uses publisher id | ✅ `tursoRuntimeIdentity.ts` |
| P1-1 Caller id for replica resolution | ✅ Same |
| P1-2 `/api/access` returned publisher `userId` | ✅ `buildMiniAppAccessResponse` |
| P1-3 Jobs inject caller params | ✅ `mergeVerifiedCallerJobParams` |
| P3-1/P3-2 Caller vs owner on access + isOwner | ✅ Landed |

### Sync V3 correctness (from deep audits — assume writer deployed)

| Area | Open question |
|------|----------------|
| **Genesis mid-cutover crash** | Behavior after fingerprint path removed |
| **Agent bash → SQLite bypass** | Writes bypass workspace log |
| **Remaining `forcePush` callers** | vs Aug-18 corruption class |
| **Dual-write metadata** | Fire-and-forget to Mongo — failure modes |
| **Job runtime off git** | Dispatch SSE vs legacy heartbeat |
| **Orphan / corrupt local DBs** | Cleanup done; prevent recurrence |

---

## 12. Decision guide for implementers

### “Which user id do I pass to Turso?”

```
if source.isolation === "per-user":
  userId = callerParseObjectId   // from session / external_user_id
else:
  userId = publisherParseObjectId  // from publish catalog doc
```

### “Which key for vault?”

```
if requirement.scope === "owner":
  resolve from publisher's vault
else if requirement.scope === "user":
  require caller signed in → caller's vault
```

### “How does the app hide rows in a shared CRM?”

```
const { userId, publisherUserId, isOwner } = await fetch('/api/access')
// userId = caller (row filters)
// publisherUserId = catalog owner (admin)
// INSERT ... papr_user_id = userId
// SELECT ... WHERE papr_user_id = userId
```

Platform will **not** do this automatically.

---

## 13. Key files

### Paprwork V2

| Area | Files |
|------|-------|
| Cloud app host | `src/gateway/services/appRuntime/CloudAppHostService.ts` |
| Turso adapter | `src/gateway/services/appRuntime/TursoDbAdapter.ts` |
| Access helpers | `src/gateway/services/appRuntime/miniAppAccess.ts` |
| Turso naming | `src/gateway/services/tursoDatabaseNaming.ts` |
| Turso acting user | `src/gateway/services/appRuntime/tursoRuntimeIdentity.ts` |
| Per-user access | `src/gateway/services/appRuntime/cloudAppPerUserAccess.ts` |
| DB registry | `src/gateway/services/DatabaseRegistryService.ts` |
| Desktop Turso bridge | `src/gateway/services/TursoSyncBridge.ts` |
| Agent cloud tools | `src/core/tools/cloudObservability.ts`, `CloudObservabilityService.ts` |
| Acting user | `src/gateway/utils/cloudActingUser.ts`, `paprUserId.ts` |
| Memory scope | `src/gateway/utils/memoryScopeResolver.ts` |
| Message sync payload | `src/gateway/services/storage/paprSyncPayload.ts`, `PaprMemoryProvider.ts` |
| Vault runtime | `src/gateway/services/appRuntime/memoryRuntimeClient.ts` |
| Sync V3 | `src/gateway/services/syncV3/*`, `WorkspaceLogClient.ts` |

### Memory server

| Area | Files |
|------|-------|
| Access validate | `services/cloud_app_publish_service.py` |
| Runtime / Turso / vault | `services/cloud_app_runtime_service.py` |
| Acting user (cloud) | `services/cloud_acting_user.py` |
| DeveloperUser / memory | `services/user_utils.py`, `routers/v1/user_routes.py` |
| Workspace log | workspace log routes + `papr_db_sync.py` |

---

## 14. One-page mental model

```
SIGNUP → Parse _User (email + objectId)
           ↓
DESKTOP LOGIN → PAPR_API_KEY (namespace) + paprUserId in settings
           ↓
                    ┌──────────────────────────────┬─────────────────────────┐
                    │ CLOUD / TURSO / SYNC         │ MEMORY API              │
                    │ external_user_id = Parse id  │ external_user_id only   │
                    │ (passthrough — NOT Developer │ → DeveloperUser lookup  │
                    │  User resolve) ⚠ naming bug  │   → anon shadow (idB)   │
                    └──────────────────────────────┴─────────────────────────┘
           ↓
WEB APP (apps.papr.ai) — caller/publisher split landed
  Session = caller
  /api/access → userId (caller), publisherUserId (owner)
  Turso replica = owner (shared) OR caller (per-user)  ✅ fixed
  SQL rows = app's job to filter (shared DB)
  Jobs → PAPR_CALLER_USER_ID injected when signed in   ✅
           ↓
VAULT
  owner keys → publisher
  user keys  → caller (sign-in required)
           ↓
IDENTITY BACKFILL (still needed)
  DeveloperUser + Chat + PostMessage + Memory + Neo4j + Qdrant: idB → idA
```

---

*This doc is the umbrella summary. For binding sync behavior use `SYNC_CONTRACT.md`. For V3 rollout use `SYNC_V3_IMPLEMENTATION_PLAN.md`.*
