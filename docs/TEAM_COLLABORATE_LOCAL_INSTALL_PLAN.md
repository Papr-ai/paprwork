# Team Collaborate — Local Install Plan

**Status:** Draft plan (2026-09-10)  
**Parent:** [`SYNC_TURSO_REPLICA_PLAN.md`](./SYNC_TURSO_REPLICA_PLAN.md) (Plan A — active)  
**Goal:** Desktop local install matches web team behavior — **collaborate = owner's Turso primary**, **fork = installer's own empty DB**.

---

## 1. Problem statement

Web team apps work: `visibility: team` + `isolation: shared` → all teammates read/write the **publisher's Turso primary** on `apps.papr.ai`.

Desktop install does **not** match:

| Path today | Code | Database |
|------------|------|----------|
| Fork | New local `appId` ✅ | Keeps publisher `dbId` ❌ — should mint new |
| Track ("Collaborate") | New local `appId`, code sync ✅ | Pulls installer's Turso ❌ — should attach to publisher primary |

Both modes run the same `installCloudAppLinkedResources` → `bootstrapInstalledAppDatabases` pipeline. Turso tokens always resolve against the **signed-in installer's** `user8` segment, not the publisher's.

---

## 1b. Workspace (Team Apps) vs Community — different rules

**Yes — this is different.** Shared owner DB is a **workspace/team** feature, not a community default.

| Surface | Catalog tab | Typical `visibility` | Trust boundary | Local install: shared owner DB? |
|---------|-------------|----------------------|----------------|--------------------------------|
| **Team Apps** | `scope=namespace` | `team` | Same namespace members (ACL) | **Yes** — track/collaborate attaches to publisher Turso |
| **Community Apps** | `scope=global` | `public_read` | Strangers / any Papr user | **No** — always fork → new `dbId`, empty DB |
| **Live web (either)** | — | team or public_read | ACL-checked per request | **Read** on publisher Turso OK; write per `linkPermission` |

### How to think about it

**Team / workspace = "we work on the same thing."**
- Same namespace, invited members, shared jobs/data is expected.
- Track + shared DB = one Turso primary, many local replicas (matches web today).

**Community = "I found a template / app in the wild."**
- Installer is usually **not** in the publisher's namespace.
- Letting them attach to the publisher's production Turso would expose owner data and allow cross-tenant writes — **must not happen**.
- Community install = **fork only** for local: new app id, new `dbId`, empty database, optional seed job from repo.
- "Collaborate and get updates" (**track**) should **not** be offered on the global Community tab (or if offered, track = **code only**, never shared DB).

### Web vs local (community)

| | Web (`apps.papr.ai`) | Local install (Community) |
|--|----------------------|---------------------------|
| **public_read demo** | Visitor reads publisher's shared Turso (demo data) | Fork gets **schema only** — not live shared DB |
| **Template with sample data** | Owner's rows on web | Ship via **seed job / migrations**, or future **"duplicate with data"** one-time snapshot — not ongoing shared link |

### UI / API enforcement

Today both tabs use the same `CloudCatalogInstallModal` (fork vs track) and `POST /api/cloud/install` without passing `visibility` or catalog scope — **wrong for community**.

| Change | Where |
|--------|-------|
| Community tab: hide **track** option; only **Fork** (or rename to "Install copy") | `CommunityAppsView` when `scope === "global"` |
| Team tab: keep fork + track; track copy explains shared team database | `scope === "namespace"` |
| Gateway: reject `mode: "track"` + shared DB attach when publish `visibility !== "team"` or caller lacks namespace read | `CloudAppInstallService` + memory install prepare |
| Lineage: `databasePolicy: "forked"` forced for community installs | install service |

### Memory ACL (already aligned)

- `visibility: team` → db-token requires `caller_has_namespace_read` → shared Turso names allowed.
- `visibility: public_read` → web read OK; **local install** should not mint publisher write replica for arbitrary installers outside namespace.

---

## 2. Target behavior

### 2.1 Product rules

**Team Apps tab only** (namespace scope, `visibility: team`):

| Mode | User intent | `appId` | `dbId` | Turso primary | Local SQLite |
|------|-------------|---------|--------|---------------|--------------|
| **Fork** | "My own copy" | New UUID | **New** (`newDbId()`) | Installer's segment, **empty** | Schema from migrations; optional seed job |
| **Track / collaborate** | "Same team app + data" | New UUID (UI shell) | **Same as publisher** | **Publisher's segment** (`lineage.source.userId`) | Plan A embedded replica; `pull()` from owner primary |

**Community Apps tab** (global scope, `visibility: public_read`):

| Mode | User intent | `appId` | `dbId` | Turso primary | Local SQLite |
|------|-------------|---------|--------|---------------|--------------|
| **Install / fork** (only option) | "Template for me" | New UUID | **New** (`newDbId()`) | Installer's segment, **empty** | Schema + optional **seed job** — never publisher attach |
| ~~Track~~ | N/A | — | — | — | Not offered (or code-only track without shared DB — defer) |

### 2.2 Success criteria

1. **Collaborate install:** After install, local app shows **same row count** as publisher web app (within sync latency).
2. **Collaborate write:** Teammate edit on desktop → visible on web + owner's desktop after sync.
3. **Fork install:** Local DB is **empty** (schema only); no reads from publisher Turso.
4. **Fork write:** Does not affect publisher or other teammates.
5. **Track code sync:** Pulling upstream revision does **not** wipe or re-copy SQLite from git; only code files update.
6. **Security:** Installer without namespace read ACL cannot obtain publisher Turso token.
7. **Per-user isolation:** Collaborate attach **refused** when linked DB is `isolation: "per-user"` (must fork or use web).

---

## 3. Architecture

### 3.1 Data flow — collaborate (track + shared DB)

```
Publisher desktop                    Memory                         Teammate desktop
─────────────────                    ──────                         ─────────────────
Turso primary ◄─── runtime/db-token ─┤ team ACL check
     ▲                               │
     │ writes                        │
     │                               │
Web apps.papr.ai ────────────────────┘
     ▲
     │ pull() / push() via Plan A replica
     │
Teammate local data.db (embedded replica, same tursoShortName + publisher user8)
```

### 3.2 Data flow — fork

```
Teammate install
  → newDbId in registry
  → apply migrations (empty schema)
  → provision empty Turso on installer's user8
  → optional seed job
  → NO token request against publisher segment
```

### 3.3 Key identity fields (already available)

From `papr-cloud-lineage.json` (`CloudAppLineageSource`):

- `source.userId` — publisher Parse id (Turso `{user8}` segment)
- `source.appId`, `source.slug`, `source.namespaceId`, `source.orgId`
- `mode: "fork" | "track"`

New field (lineage v1.2):

- `databasePolicy: "shared" | "forked"` — persisted for track sync + debugging

---

## 4. Implementation phases

### Phase 0 — Spec + types (paprwork-v2)

**Scope:** No runtime behavior change; add types and policy enum.

| File | Change |
|------|--------|
| `src/core/types/cloudAppLineage.ts` | Add `databasePolicy?: "shared" \| "forked"`; bump schema to `1.2.0` |
| `src/gateway/services/cloudInstallDbPolicy.ts` | **New** — `resolveInstallDbPolicy(mode, registryIsolation): "shared_primary" \| "fork_empty"` |
| `docs/TEAM_COLLABORATE_LOCAL_INSTALL_PLAN.md` | This doc |

**Policy rules:**

```typescript
// track + all linked sources isolation === "shared" → shared_primary
// track + any per-user source → error (require web or fork)
// fork → fork_empty
```

---

### Phase 1 — Fork: mint new `dbId` (paprwork-v2)

**Scope:** Fork path stops inheriting publisher DB identity.

| File | Change |
|------|--------|
| `src/gateway/services/copyAppToNamespace.ts` | `mergeDatabaseRegistryForCopy(..., { forkDbIds: true })` — clone registry entry with `newDbId()`, rewrite `data-sources.json` refs |
| `src/gateway/services/cloudAppLinkedResourcesInstall.ts` | Pass `installDbPolicy` from install service |
| `src/gateway/services/CloudAppInstallService.ts` | Compute policy from `prepare.mode`; pass through linked resources + bootstrap |
| `src/gateway/services/cloudAppInstallBootstrap.ts` | Fork: skip publisher Turso pull; seed empty replica only |

**Do not copy:** Publisher `data/databases/{slug}/data.db` bytes into fork (migrations only).

**Lineage:** Write `databasePolicy: "forked"`.

---

### Phase 2 — Collaborate: publisher Turso credentials (paprwork-v2 + memory)

**Scope:** Track install resolves Turso against publisher segment.

#### paprwork-v2

| File | Change |
|------|--------|
| `src/gateway/services/cloudInstallTursoCredentials.ts` | **New** — `fetchTursoCredentialsForInstall({ policy, lineage, tursoShortName })` |
| `src/gateway/services/TursoSyncBridge.ts` | Optional `actingUserId` override on credential fetch |
| `src/gateway/services/tursoReplica/tursoReplicaRouting.ts` | Read lineage file; set `publisherUserId = lineage.source.userId` for shared-primary apps |
| `src/gateway/services/cloudAppInstallBootstrap.ts` | Track: call replica cutover `pull_remote` path with publisher creds |
| `src/gateway/services/tursoReplica/portableReplicaBootstrap.ts` | Track: **skip** `pushReplicaBootstrapViaTursoSync` (do not seed installer's Turso with copied SQLite) |

**Credential strategy (pick one in Phase 2 spike):**

| Option | Endpoint | Pros | Cons |
|--------|----------|------|------|
| **A (preferred)** | Reuse `POST /v1/cloud/apps/runtime/db-token` | Same as web; ACL already enforced | Needs slug + session; desktop must prove team access |
| **B** | Extend `POST /v1/cloud/databases/token` | Desktop already uses it | Must add `publisher_user_id` + app-scoped ACL |

Recommendation: **Option A** — mirror web path via `memoryRuntimeClient.fetchRuntimeDbToken()` with installer's session + publisher app slug. Memory already computes allowlist from publisher repo.

#### memory

| File | Change |
|------|--------|
| `services/cloud_app_runtime_service.py` | Ensure desktop install session (namespace read ACL) can mint db-token for **publisher** `user_id` on shared sources |
| `services/cloud_linked_sources.py` | No change if allowlist already includes shared base names for team callers |
| `services/cloud_app_install_service.py` | Optional: return `sharedDbIds[]`, `publisherUserId` in install prepare response |
| `tests/test_cloud_linked_sources_allowlist.py` | Team member caller → publisher shared DB allowed |
| `tests/test_cloud_app_runtime_routes.py` | Team member db-token for publisher app |

**Lineage:** Write `databasePolicy: "shared"`.

---

### Phase 3 — Replica attach + bootstrap (paprwork-v2)

**Scope:** First open after collaborate install pulls owner primary into local replica.

| File | Change |
|------|--------|
| `src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.ts` | New entry: `attachTeamSharedPrimary()` — classify `pull_remote`, Turso wins, no local push |
| `src/gateway/services/tursoReplica/TursoReplicaService.ts` | Accept explicit credentials from install bootstrap (bypass default fetch) |
| `src/gateway/services/cloudAppInstallBootstrap.ts` | Return structured result: `{ attachedToPublisher: true, rowCount }` |
| Registry | Set `syncMode: "replica"`, store `publisherUserId` on record (new optional field) or rely on lineage |

**Marker:** New bootstrap reason `team_collaborate_attach` in `tursoReplicaBootstrapMarker.ts`.

---

### Phase 4 — Track sync: code only, re-pull shared DB (paprwork-v2)

**Scope:** `CloudAppTrackSyncService` must not re-copy SQLite from git.

| File | Change |
|------|--------|
| `src/gateway/services/CloudAppTrackSyncService.ts` | After code sync: if `databasePolicy === "shared"`, `reconcileFromCloud()` for linked dbIds only — **no** `syncAppLinkedResourcesToTarget` DB file copy |
| `src/gateway/services/cloudAppLinkedResourcesInstall.ts` | Split: `syncAppCodeResources` vs `syncAppDatabaseResources` |

---

### Phase 5 — UI clarity (paprwork-v2)

| File | Change |
|------|--------|
| `ui/components/Apps/CloudCatalogInstallModal.tsx` | **Team tab:** Fork = "My own database (empty)"; Collaborate = "Shared team database (same data as web)". **Community tab:** single "Install copy" — no track button |
| `ui/components/Apps/CommunityAppsView.tsx` | Pass `catalogScope` into modal; `scope === "global"` → skip fork/track chooser, always fork |
| `ui/hooks/useCloudCatalogInstallFlow.ts` | Surface bootstrap result warnings (empty remote, per-user blocked) |
| `ui/components/Apps/MiniAppPublishBar.tsx` | Optional: show "Collaborators sync to your database" for team publish |

**Future (not Phase 5):** Community "Install with sample data" — one-time snapshot at fork (billed), not live shared DB. Team-only: "Collaborate on code only (my database)" — track + fork DB.

---

## 5. Test plan

### 5.1 Unit tests (paprwork-v2 — vitest, no network)

| Test file | Cases |
|-----------|-------|
| `tests/cloud-install-db-policy.test.ts` | **New** — fork → `fork_empty`; track+shared → `shared_primary`; track+per-user → error |
| `tests/cloud-install-fork-registry.test.ts` | **New** — fork remints `dbId`, rewrites `data-sources.json`, preserves job ids |
| `tests/cloud-install-collaborate-credentials.test.ts` | **New** — mock memory client: track passes `publisherUserId` from lineage; fork never calls publisher token |
| `tests/cloud-app-install-bootstrap.test.ts` | Extend — collaborate mock returns `attachedToPublisher: true`; fork returns `empty_local` |
| `tests/portable-replica-bootstrap.test.ts` | Extend — track skips push-to-installer; fork still seeds own Turso |
| `tests/turso-replica-cutover.test.ts` | Extend — `team_collaborate_attach` → `pull_remote`, never `seed_local` from copied bytes |
| `tests/turso-runtime-identity.test.ts` | Extend — routing reads lineage publisher for shared-primary install |
| `tests/cloud-app-lineage.test.ts` | Extend — schema 1.2 `databasePolicy` round-trip |

Run: `npx vitest run tests/cloud-install-*.test.ts tests/cloud-app-install-bootstrap.test.ts --project unit-backend`

### 5.2 Memory unit tests (memory repo)

| Test file | Cases |
|-----------|-------|
| `tests/test_cloud_linked_sources_allowlist.py` | Team member + shared registry → publisher base turso name in allowlist |
| `tests/test_cloud_app_runtime_routes.py` | Namespace read member gets db-token; non-member 403; per-user source gets caller suffix only |
| `tests/test_cloud_app_install_routes.py` | **New/extend** — install prepare returns publisher metadata |

Run: `pytest tests/test_cloud_linked_sources_allowlist.py tests/test_cloud_app_runtime_routes.py -q`

### 5.3 Integration tests (paprwork-v2 — mocked memory)

| Test file | Cases |
|-----------|-------|
| `tests/cloud-install-collaborate-integration.test.ts` | **New** — full `installApp` mock: track → registry keeps dbId, bootstrap calls publisher creds, local sqlite row count matches fixture |
| `tests/cloud-install-fork-integration.test.ts` | **New** — fork → new dbId, no publisher token call, zero user tables after bootstrap |

Use isolated workspace (`tests/setup/isolatedWorkspace.ts`) pattern from `cloud-linked-resources-install.test.ts`.

### 5.4 E2E script (manual / CI with credentials)

**New:** `scripts/test-team-collaborate-install-e2e.mjs`

**Prerequisites:**

- Two Papr accounts in same namespace (publisher + teammate)
- Publisher app published team + shared DB with known row count
- `PAPR_API_KEY` for both (or OAuth sessions)

**Steps:**

```
1. Publisher: seed app with identifiable rows (e.g. INSERT ... 'e2e-marker-{timestamp}')
2. Publisher: Upload + verify Turso synced
3. Teammate: POST /api/cloud/install { mode: "track", slug, namespaceId }
4. Assert: bootstrap report attachedToPublisher === true
5. Assert: local sqlite COUNT(*) includes e2e-marker
6. Teammate: INSERT new row via app or papr_db_exec
7. Publisher web: verify row visible (poll apps.papr.ai)
8. Teammate fork install same app
9. Assert: different dbId, COUNT(*) === 0 for marker (unless copied — must be 0)
```

Add npm script: `"test:team-collaborate-install": "node scripts/test-team-collaborate-install-e2e.mjs"`

### 5.5 Regression matrix

| Scenario | Fork | Collaborate |
|----------|------|-------------|
| Install completes | ✅ | ✅ |
| Same rows as web | ❌ empty | ✅ match |
| Write visible to publisher | ❌ | ✅ |
| Write visible to other teammate | ❌ | ✅ |
| Track code pull | N/A | ✅ code updates, data preserved |
| Per-user DB app | ✅ own empty | ❌ blocked with clear error |
| Offline edit + reconnect | Own primary | Outbox → owner primary |
| Publisher unpublishes | Local fork survives | Token denied; local read-only cache? |

---

## 6. Implications

### 6.1 Security

| Risk | Mitigation |
|------|------------|
| Teammate accesses publisher DB without ACL | Memory allowlist + `validate_access` on db-token; fail closed |
| Teammate escalates to owner vault keys | Unchanged — `credentialScope: owner` still resolves publisher vault server-side |
| Fork accidentally retains publisher dbId | Phase 1 tests enforce new dbId; lineage `databasePolicy: forked` |
| Cross-namespace install | Install API already scoped to namespace; token denied if wrong ns |

### 6.2 Write conflicts (multi-writer shared DB)

Plan A already assumes **Turso primary serializes writes**. Implications for collaborate:

- Two teammates editing offline → LWW on reconnect (same as web + owner desktop today)
- **No row-level locking** — apps must tolerate concurrent edits or use app-level guards
- Agent should use `papr_db_sync_status` / `repair_cloud_sync` on conflict errors

**Doc update:** Add collaborate section to `SYNC_CONTRACT.md` § conflicts.

### 6.3 Schema changes

- **Schema owner** remains publisher app (`schemaOwnerAppId`)
- Collaborators apply migrations locally → Plan A routes DDL to **owner Turso primary**
- Collaborator must not ship migration files via writer ops unless schema owner (existing rule)

**Test:** Collaborate install blocked if local migration ledger ahead of owner primary (schema gate).

### 6.4 Jobs and linked resources

- **Job ids preserved** on both fork and collaborate (from repo)
- **Job runtime state** (lastRunAt, status) stays local/Mongo — not shared
- **Job `data/data.db`** — if job-owned DB linked, same policy: fork mints new job db path; collaborate attaches to publisher job Turso segment

### 6.5 Offline / cloud-off

| State | Collaborate behavior |
|-------|---------------------|
| Cloud on, online | Replica tails owner primary |
| Cloud on, offline | Provisional local writes → outbox → push to **owner primary** on reconnect |
| Cloud off | **Block collaborate attach** at install (requires cloud for shared primary) — offer fork instead |

### 6.6 Publisher leaves team / unpublish

- Collaborate installs keep local replica cache but lose write token
- UI: "Upstream unavailable — switch to fork or contact owner"
- No automatic conversion to fork (data loss risk)

### 6.7 Performance

- First collaborate install: one-time **bootstrap pull** (same cost as bucket C cutover)
- Large DBs (100k+ rows): show progress in install modal; consider background bootstrap
- Track code sync must **not** re-pull full DB unless remote ahead (use sync-index / cheap ahead check)

### 6.8 Billing / Turso cost

- Collaborate reads/writes count against **publisher's** Turso databases (same as web)
- Fork creates **new** Turso DBs under installer (new cost center)

---

## 7. Rollout

| Stage | Flag / gate | Audience |
|-------|-------------|----------|
| Dev | `PAPR_TURSO_REPLICA_SYNC=replica-records` + new code | Internal |
| Beta | Same + install modal copy update | Team workspaces only |
| GA | Default on when Plan A replica GA | All |

**No separate feature flag initially** — behavior gated by install `mode` + `databasePolicy`. Add `PAPR_TEAM_COLLABORATE_DB=0` kill switch only if needed during beta.

**Migration:** Existing track installs (wrong db attachment) — one-time repair script:

```bash
# Future: npm run repair:track-install-db -- --app-id=<uuid>
# Re-read lineage, re-attach to publisher primary if databasePolicy missing and mode=track
```

---

## 8. Open questions (product)

1. **Community track (code-only)** — ever offer "pull upstream code updates" without shared DB, or fork-only forever?
2. **Track + own DB (team)** — third install option needed, or fork covers it?
3. **Read-only collaborate** — namespace read but not write: allow pull-only replica?
4. **Community sample data** — seed job only vs optional paid "duplicate with data" at install?
5. **Auto-repair** existing track installs created before this ship?
6. **Large DB UX** — block install until bootstrap completes, or open app with loading state?

---

## 9. Implementation order (recommended)

```
Week 1: Phase 0 + Phase 1 (fork db mint) + unit tests
Week 2: Phase 2 memory token + Phase 3 replica attach + integration tests
Week 3: Phase 4 track sync split + Phase 5 UI + E2E script
Week 4: Dogfood, repair script, SYNC_CONTRACT doc update, CLAUDE.md entry
```

**First PR (smallest shippable):** Phase 1 only — fork gets new `dbId`. Stops the worst bug (fork accidentally pointing at publisher id). Collaborate unchanged until Phase 2.

---

## 10. File checklist (quick reference)

### paprwork-v2 — new files

- `src/gateway/services/cloudInstallDbPolicy.ts`
- `src/gateway/services/cloudInstallTursoCredentials.ts`
- `tests/cloud-install-db-policy.test.ts`
- `tests/cloud-install-fork-registry.test.ts`
- `tests/cloud-install-collaborate-credentials.test.ts`
- `tests/cloud-install-collaborate-integration.test.ts`
- `scripts/test-team-collaborate-install-e2e.mjs`

### paprwork-v2 — modify

- `CloudAppInstallService.ts`
- `cloudAppLinkedResourcesInstall.ts`
- `copyAppToNamespace.ts`
- `cloudAppInstallBootstrap.ts`
- `CloudAppTrackSyncService.ts`
- `tursoReplicaRouting.ts`
- `portableReplicaBootstrap.ts`
- `cloudAppLineage.ts`
- `CloudCatalogInstallModal.tsx`

### memory — modify

- `cloud_app_runtime_service.py` (verify desktop team db-token)
- `tests/test_cloud_linked_sources_allowlist.py`
- `tests/test_cloud_app_runtime_routes.py`

---

## 11. Related docs

- [`SYNC_TURSO_REPLICA_PLAN.md`](./SYNC_TURSO_REPLICA_PLAN.md) — Plan A replica authority
- [`SYNC_REPLICA_GENESIS_AND_AUTHORITY_PLAN.md`](./SYNC_REPLICA_GENESIS_AND_AUTHORITY_PLAN.md) §5.2–5.3 — fork vs team collab product rules
- [`SYNC_CONTRACT.md`](./SYNC_CONTRACT.md) — binding sync behavior (update after ship)
- [`ARCHITECTURE_CONVERSATION_SYNTHESIS.md`](./ARCHITECTURE_CONVERSATION_SYNTHESIS.md) — shared vs per-user isolation
