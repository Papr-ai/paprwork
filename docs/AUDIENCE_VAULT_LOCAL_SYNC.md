# Audience Vault Local Sync — Design

**Status:** Implemented (2026-09-10)  
**Date:** 2026-09-10

## Problem

Integration keys have two independent controls:

| Control | Question it answers | Syncs to other users today? |
|---|---|---|
| **Org scope** | Where does *I* store this key locally (all orgs / this org / specific org)? | **No** — portability for the adder only |
| **Audience** | Who else can *use* this key (Only me / Team / Organization)? | **Cloud only** — GCP Secret Manager via memory server |

When Audience is **Team** or **Organization**, teammates can resolve the secret in **cloud runtime** (mini-apps, cloud jobs, cloud agent sandboxes). They **cannot** use it in **desktop local** agent/bash/jobs because those paths read only from the local keychain.

This doc specifies pulling Audience-shared keys into eligible members' local keychains.

---

## Goals

1. **Parity:** If a teammate shared `GOOGLEDRIVE` with Audience = Organization, other org members get it locally so `${GOOGLEDRIVE}` works in desktop bash/jobs/agent.
2. **Correct separation:** Org scope still only affects the **adder's** local portability — never grants access to others.
3. **Safety:** Pulled keys are read-only mirrors; owners retain edit/delete authority in cloud.
4. **No new ACL model:** Reuse memory server `resolve_key_values` / list scoping — same rules as cloud runtime.

## Non-goals (v1)

- Cross-device sync of **user-scoped** keys (Only me) — separate feature; list endpoint already hints at missing keys but has no values API.
- Letting non-owners edit shared key values locally.
- Pushing org-scope metadata changes from a mirror back to cloud.

---

## Current architecture (baseline)

```
Desktop add/edit
  → CustomKeysStorage (local keychain)
  → VaultSyncService.pushAllKeys()
  → Gateway /api/cloud/vault/sync
  → Memory POST /v1/cloud/vault/sync
  → GCP Secret Manager (one canonical secret per key + ACL labels)

Desktop pull (today)
  → GET scope=user only, names only, no local write

Cloud runtime (today)
  → vault-resolve / resolve_key_values
  → user → namespace → org cascade
  → Team/Org audience works ✅

Desktop local agent/bash (today)
  → CustomKeysService → local keychain only
  → Team/Org audience does NOT work for non-owners ❌
```

---

## Desired behavior

### Audience matrix (after implementation)

| Audience | Cloud (unchanged) | Other users' local keychain (new) |
|---|---|---|
| **Only me** | `papr-share-scope: user` | Not pulled |
| **Team** | `papr-share-scope: namespace` + `papr-namespace-id` | Pulled for members of that namespace |
| **Organization** | `papr-share-scope: org` | Pulled for all members of that org |

### Org scope (unchanged)

| Org scope | Effect |
|---|---|
| **All organizations** | Adder's key lives in `_shared` local vault; they can use it in any org they switch to |
| **This org / Specific org** | Adder's key lives in that org's local vault |

Org scope **never** causes keys to appear on other users' devices.

### Ownership & conflicts

| Case | Rule |
|---|---|
| User is **owner** (`papr-owner-user` label matches acting user) | **Push only** — skip pull for that key name (local is source of truth) |
| User has **local key** with same name, `vaultOrigin: "local"` | Local wins — do not overwrite with shared mirror |
| User has **shared mirror**, cloud updated | Update local value + `syncedAt` on pull |
| Owner **deletes** or changes Audience → **Only me** | Next pull **removes** local mirror for non-owners |
| Name collision: local + shared different values | Local-owned always wins; log warning if cloud shareScope ≠ user |

### OAuth / managed keys

**Exclude from shared pull in v1:** keys with `papr-source: oauth` or `managedBy: oauth`.

Rationale: OAuth tokens are user-subscription bound; sharing them org-wide is usually wrong and creates auth confusion. Manual/API integration keys (e.g. `GOOGLEDRIVE`, `PAPRWORK_PUBLICREPOS`) are the target.

---

## Memory server changes

### New endpoint: `POST /v1/cloud/vault/pull-shared`

Authenticated desktop endpoint (PAPR API key + `external_user_id`). Returns **values** the caller may materialize locally — namespace + org scoped secrets they do **not** own.

**Request**

```json
{
  "namespace_id": "85ZIB7mD1V",
  "external_user_id": "ParseUserObjectId"
}
```

**Response**

```json
{
  "keys": [
    {
      "name": "GOOGLEDRIVE",
      "value": "...",
      "shareScope": "org",
      "syncedAt": "2026-09-10T16:00:00Z",
      "permission": "always_allow",
      "clientAccess": "server",
      "source": "manual",
      "ownerUserId": "abc123",
      "description": "Trivalence Google Drive"
    }
  ]
}
```

**Server logic** (`vault_service.pull_shared_keys_for_user`):

1. Auth → `org_id`, `namespace_id`, `user_id` (same as existing cloud routes).
2. Collect candidate names:
   - `list_keys(org_id, namespace_id=ns)` → namespace-scoped
   - `list_keys(org_id)` → org-scoped
   - Exclude entries where `labels.papr-owner-user == user_id` (owner pushes from desktop).
   - Exclude `papr-source == oauth`.
3. Resolve values via existing `resolve_key_value` cascade (already finds ns/org paths).
4. Return metadata from Secret Manager labels (`papr-permission`, `papr-client-access`, `papr-share-scope`, `papr-owner-user`).

**Security**

- Same ACL as `GET /v1/cloud/vault/keys` + resolve — no new trust boundary.
- Response is HTTPS only; desktop stores via existing `safeStorage` encryption.
- Rate-limit per user (e.g. 10/min) to avoid Secret Manager abuse.

**Alternative considered:** Reuse `apps/runtime/vault-resolve` — rejected; it requires app catalog context and owner/user partition for published apps, not general integration key sync.

---

## Paprwork desktop changes

### 1. Local key metadata

Extend `CustomKey` / `CustomKeyMetadata`:

```typescript
type VaultOrigin = "local" | "shared";

interface CustomKeyMetadata {
  // ...existing fields...
  vaultOrigin?: VaultOrigin;           // default "local"
  sharedShareScope?: "namespace" | "org";
  sharedOwnerUserId?: string;
  sharedSyncedAt?: string;             // from cloud syncedAt
}
```

- **Local keys:** `vaultOrigin: "local"` (default for user-added keys).
- **Pulled keys:** `vaultOrigin: "shared"`, read-only in UI.

Storage target for mirrors: **active org vault** (`scope: "org"`, current `organizationId`) — not `_shared`, because the secret is tied to the org/namespace context it was shared in.

### 2. `VaultSyncService` — new `pullSharedKeys()`

After existing `pushAllKeys()` + `pullKeys()`:

```
pullSharedKeys():
  1. GET active org_id + namespace_id from workspace pointer
  2. POST /api/cloud/vault/pull-shared (gateway proxy → memory)
  3. For each returned key:
     - Skip if local findKeyByName exists with vaultOrigin !== "shared"
     - upsertSharedKey() via IPC → CustomKeysStorage
  4. pruneStaleSharedKeys():
     - Remove local vaultOrigin=shared keys whose names are NOT in pull response
       (and shareScope matches current org/ns context)
```

**Triggers** (same as push today, plus shared pull):

| Event | Action |
|---|---|
| App startup / vault init | push → pull user names → **pull shared** |
| Key add/update/delete (owner) | debounced push (unchanged) |
| Workspace org/namespace switch | push → pull → **pull shared** |
| User opens **Key Vault** settings tab | **pull shared** in background (shows "Refreshing shared keys…") |

Do **not** push shared mirrors back to cloud (infinite loop). `pushAllKeys()` must skip `vaultOrigin === "shared"`.

### 3. `CustomKeysStorage`

New methods:

- `upsertSharedKey(input: SharedKeyInput)` — create or update mirror; never change owner-local keys.
- `pruneSharedKeys(validNames: Set<string>, context: { orgId, namespaceId })` — remove stale mirrors.
- `updateKey` / `deleteKey` guards:
  - **Shared mirror:** delete = "Remove from this device" only; edit value blocked.
  - **Local key:** unchanged.

### 4. Settings UI

Integration Keys list:

| Badge | Meaning |
|---|---|
| `Trivalence · Organization` | Org vault location + Audience (existing) |
| `Shared · Team` / `Shared · Organization` | **New** — pulled mirror, read-only |
| `Auto` / `Ask` | Permission (from cloud labels) |

Edit flow for shared keys:

- Show name, description, audience badge, owner hint ("Shared by organization").
- **No** value edit; **Delete** label → "Remove from this device".
- Owner's own keys: full edit (unchanged).

### 5. Gateway proxy

Add `/api/cloud/vault/pull-shared` to existing cloud proxy (no special timeout — 30s default).

---

## Cloud App Host / Gateway runtime

**No changes required.** Already resolves via memory server `vault-resolve` / `resolve_key_values`. This feature closes the desktop-local gap only.

---

## End-to-end flow (after implementation)

```
User A adds GOOGLEDRIVE
  Audience: Organization
  Org scope: This org (Trivalence)
  → Local keychain (A)
  → Push → GCP papr/{org}/GOOGLEDRIVE

User B (same org) opens Paprwork / switches to Trivalence
  → pullSharedKeys()
  → Memory returns GOOGLEDRIVE (shareScope=org, owner=A)
  → B's local keychain mirror (read-only, vaultOrigin=shared)

User B desktop agent:
  bash({ command: "curl -H 'Auth: ${GOOGLEDRIVE}' ..." })
  → CustomKeysService finds mirror ✅

User A changes Audience → Only me
  → Push updates GCP path to user-scoped
  → B's next pullSharedKeys() omits GOOGLEDRIVE
  → prune removes B's mirror ✅
```

---

## Testing plan

### Memory server (`memory/tests/`)

- Org-scoped secret visible in `pull-shared` for org member B, not for outsider.
- Namespace-scoped secret visible for namespace member, not other namespace in same org.
- Owner's own namespace/org keys excluded from pull response.
- OAuth-labeled secrets excluded.
- Deleted cloud secret → absent from pull → desktop prune removes mirror.

### Paprwork desktop (`tests/`)

- `pushAllKeys` skips `vaultOrigin: shared`.
- Local key wins over shared on name collision.
- `upsertSharedKey` idempotent; updates value when `syncedAt` newer.
- Workspace switch triggers pull + prune.

### Manual E2E

1. User A: add key, Audience = Organization, verify cloud via `GET scope=org`.
2. User B: same org, verify key appears in Settings (read-only), `${KEY}` works in bash tool.
3. User B: different org — key must **not** appear.
4. User A: delete key — B's mirror gone after sync.

---

## Implementation phases

| Phase | Scope | Repo |
|---|---|---|
| **1** | `POST /v1/cloud/vault/pull-shared` + unit tests | `memory` |
| **2** | Gateway proxy route | `paprwork-v2` |
| **3** | `VaultSyncService.pullSharedKeys`, skip shared on push | `paprwork-v2` |
| **4** | `CustomKeysStorage` upsert/prune + IPC | `paprwork-v2` |
| **5** | Settings UI read-only shared state | `paprwork-v2` ui |
| **6** | E2E + docs update in CLAUDE.md | both |

Estimated effort: **2–3 days** (Phase 1–5).

---

## Open questions

1. **User-scoped cross-device sync** — Should "Only me" keys also pull to the same user's second laptop? Out of scope here; would reuse a `pull-user` variant without sharing.
2. **Hide vs delete** — Should non-owners be able to hide a shared key locally without affecting others? Nice-to-have: `sharedHidden: true` local flag.
3. **Namespace switch within org** — Team keys from namespace A should prune when user switches to namespace B (only org-wide keys remain).
4. **Audit log** — Memory server log `pull-shared` access for security review?
5. **Selected members audience** — Implemented (see below).

---

## Selected members audience (implemented)

**Goal:** Share a key with specific workspace members (from People / workspace members list), in addition to Only me / Team / Organization.

**Proposed model:**

| Audience | Canonical secret | Who gets local mirror |
|---|---|---|
| Only me | `papr--{org}--vault--{KEY}` + `papr-share-scope: user` | Owner only (push, no pull for others) |
| Selected members | Same secret + ACL labels | Listed `userId`s via `pull-shared` filter |
| Team | Same secret + namespace label | Namespace members |
| Organization | Same secret + org scope label | All org members |

**GCP labels (one secret per key name; scope is metadata, not a path):**

- `papr-share-scope: members`
- `papr-allowed-users: uid1,uid2,uid3` (Parse objectIds, max ~63 chars per label — chunk if needed)

**Memory server changes:**

- `VaultKeyShareScope.MEMBERS = "members"`
- `sync_keys`: write allowed-users label from desktop payload
- `pull_shared_keys_for_user`: include when `share_scope == members` and caller `user_id` in allowed list
- `resolve_key_value`: same ACL check for runtime

**Desktop changes:**

- Audience selector: **Selected members** → multi-select from `papr:list-workspace-members`
- Persist `vaultAudienceMemberIds: string[]` on local key metadata
- Push member IDs in vault sync payload
- UI: owner can edit member list; shared mirrors remain read-only (View only)

**Name collisions (shared scopes):**

- Cloud **rejects** sync when a Team/Org/Members key name already exists with a **different owner** (`conflicts` with `reason: name_taken`).
- Desktop marks the local key **`vaultShareBlocked`** and shows a **Not shared** badge; the key still works locally for `${KEY}` substitution.
- If a teammate's shared mirror already exists locally, adding the same name is blocked in the UI (use View or remove the mirror first).
- When both a local key and a shared mirror share a name, **local wins** for substitution; UI shows **Duplicate name** (`vaultSharedNameCollision`).

---

## Related docs

- `docs/PAPR_CLOUD_RUNTIME_PLAN.md` — vault ACL model (§9)
- `ui/constants/integrationKeyVaultAudience.ts` — Audience labels
- `src/gateway/services/VaultSyncService.ts` — current push/pull
- `memory/services/vault_service.py` — canonical secrets + ACL resolve (legacy path fallback on read)
