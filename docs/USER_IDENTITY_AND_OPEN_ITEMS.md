# User Identity Flows & Open Items

> **Superseded by the full conversation synthesis:** [`ARCHITECTURE_CONVERSATION_SYNTHESIS.md`](./ARCHITECTURE_CONVERSATION_SYNTHESIS.md)  
> (covers mini-app access, Turso ACL, owner vs caller, vault, sync V3, and open items P0–P4.)

This file retains the **Memory / DeveloperUser / signup** detail only.

**Last updated:** 2026-08-20

---

## The big picture (3 separate layers)

Do not mix these up:

| Layer | What it controls | Example |
|-------|------------------|---------|
| **1. Publish / app ACL** | Who can open an app on `apps.papr.ai` | team read, link token, owner |
| **2. Turso replica selection** | Which physical DB file is used | `p-{org}-{ns}-{user8}-{db}` |
| **3. Row-level filtering** | Who sees which rows inside a DB | App columns like `papr_user_id` — **not enforced by platform on raw SQL** |

---

## What Paprwork sends today

After Papr login/signup:

| Field | Value | Purpose |
|-------|--------|---------|
| **API key** | Namespace-scoped `PAPR_API_KEY` | Authenticates org + namespace |
| **`external_user_id`** | Parse `_User.objectId` (`paprUserId`) | Says *who is acting* |
| **Email** | Stored locally only | **Not** sent on Memory/Cloud API calls |

The API key’s `developer_id` on the server is usually the **org owner** (from org-based keys), not necessarily the person using the app.

---

## Flow A: Signup / login (Papr account)

```
User signs up (Auth0) → Parse _User created (objectId + email)
                      → Paprwork stores paprProfile in settings.json
                      → Namespace + API key provisioned (first login)
```

| Where | What’s stored |
|-------|----------------|
| Parse **`_User`** | Real email, display name, objectId |
| Local **`settings.json`** | `paprProfile.email`, `profile.paprUserId` |
| **`DeveloperUser`** | **Nothing** at signup (not created here) |

---

## Flow B: Cloud / Turso / sync / publish

**Endpoint pattern:** `/v1/cloud/*` with namespace API key + `external_user_id`

```
API key → org + namespace + developer_id (org owner)
external_user_id → acting user (Parse objectId)
                   ↓
resolve_cloud_acting_user_id()
  - If acting user == key holder → use them
  - If different → require namespace read ACL on acting user
  - Returns real Parse objectId (NOT anonymous)
                   ↓
Turso token minted for p-{org}-{ns}-{acting_user8}-{db}
```

**Takeaway:** Logged-in users are **identified as their real Parse account** on this path. Team member B gets **their own** Turso segment, not the owner’s.

---

## Flow C: Memory API (add / search / messages)

**What Paprwork sends:** `external_user_id` only (Parse objectId), via `getPaprUserId()` / `memoryScopeResolver`.

```
API key → developer_id = org owner
external_user_id → treated as developer-scoped "external id" string
                   ↓
Lookup DeveloperUser(developer, external_id, namespace)
  - Found → use linked internal user_id (often a shadow user)
  - Not found → auto-create:
      • New shadow _User (anon_*, @anon.papr.ai)
      • DeveloperUser row: external_id = Parse objectId string
                            user → shadow _User (NOT signup account)
```

**Takeaway:** Same person is **not anonymous**, but Memory’s **internal `user_id` may be a shadow account**, not the signup `_User`.

ACL tags like `external_user:{ParseObjectId}` still carry the real id string for sharing/search scope.

---

## Flow D: First-party path (not used by Paprwork today)

If a client sends **both**:

- `user_id` = Parse objectId  
- `external_user_id` = same Parse objectId  

Memory **skips DeveloperUser resolution** and uses the real `_User` directly.

Email is **not** used in this path either.

---

## Flow E: Email — where it lives & what it does

| Use | Does email help? |
|-----|------------------|
| Signup / `_User.email` | Yes — canonical account email |
| Local Paprwork settings | Yes — UI / profile |
| `list_namespace_users` (agent tool) | Yes — agent matches email → `externalUserId` for ACL sharing (**client-side**) |
| Memory user resolution | **No** — email not sent; auto-create ignores it |
| `POST /user` with email + external_id | Stores email on **DeveloperUser** row only; still creates **shadow** `_User` |
| Cross-namespace user merge | **No** — no server-side “same email = same person” |

---

## Flow F: Team member vs owner

**Owner A’s team app, member B logged into Paprwork:**

| Path | B sees A’s live shared DB? |
|------|----------------------------|
| `apps.papr.ai` (team `canRead`) | **Yes** — publisher’s Turso scope |
| Desktop `query_cloud_turso` | **No** — token is for B’s replica, not A’s |
| Memory (B’s writes) | Scoped to B’s identity / ACL; separate DeveloperUser per namespace |

---

## Flow G: Anonymous vs identified

| State | Behavior |
|-------|----------|
| **Logged in** | `external_user_id` sent → identified (cloud = real user; memory = external id string + maybe shadow internal id) |
| **Not logged in** | No `external_user_id` → memory falls back to org owner; telemetry uses install id |
| **Share-link visitor (web)** | Token/session only → no Papr account attribution |

---

## Identity model cheat sheet

| Question | Cloud/Turso | Memory (current Paprwork) |
|----------|-------------|---------------------------|
| Same as signup `_User`? | **Yes** (Parse objectId) | **Not guaranteed** (shadow via DeveloperUser) |
| Cross-namespace same person? | Same objectId if same login | Separate DeveloperUser row per namespace |
| Email links accounts? | **No** | **No** |
| Anonymous when logged in? | **No** | **No** (but internal id may be wrong) |

---

## Open items / bugs / things to address

### P0 — Identity correctness (Memory)

1. **Paprwork should send `user_id` + `external_user_id` on Memory calls**  
   Both = Parse objectId. Uses first-party path → real `_User`, no shadow DeveloperUser on new writes.  
   *Files:* `memoryScopeResolver.ts`, `paprMemory.ts`, `PaprMemoryProvider.ts`, SDK call sites.

2. **Existing bad DeveloperUser mappings**  
   Users who already hit memory may have `external_id = ParseObjectId` → shadow `anon_*` user. Sending `user_id` fixes forward writes but **does not repair** old rows or existing DeveloperUser pointers. May need migration or explicit DeveloperUser upsert at login.

3. **`create_developer_user` always creates shadow users**  
   Memory server never links `DeveloperUser.user` to an existing signup `_User` by email or objectId. Third-party API design; Paprwork should not rely on auto-create for first-party users.

### P1 — Possible Memory server bug

4. **`_resolve_user_for_memory_parallel_v2` may ignore top-level `external_user_id`**  
   Search path copies request-level `user_id` / `external_user_id` into metadata; memory V2 path only checks `memory_request.metadata.*`. If true, top-level-only `external_user_id` (what Paprwork sends) might fall through to **org owner** as end user. **Verify in memory repo and fix parity with search resolver.**

### P1 — Product / architecture gaps

5. **No cross-namespace identity merge**  
   Same person in two namespaces = two DeveloperUser records (under each org owner). Email does not dedupe. Accept or design explicit “link Papr account at join workspace” provisioning.

6. **Cloud vs Memory identity split**  
   Turso/sync uses real Parse user; Memory graph may use shadow user. Confusing for support/debugging and for “one user across Papr.”

7. **Email not on Memory payloads**  
   Even if added, current server logic would **not** join to signup `_User` without API changes.

8. **Org API key → developer_id = org owner**  
   Documented behavior; acting user always comes from `external_user_id` / session. Ensure all Paprwork call sites pass acting user consistently.

### P2 — Related from broader sync/cloud work (same review thread)

9. **Production 500 on workspace log** when `namespace_id` is null (memory server) — fix deployed locally, needs prod deploy.

10. **Cloud app host caller replica resolution** — per-user DBs should use caller’s user segment, not always publisher’s (TursoDbAdapter / `/api/access`).

11. **Turso “Synced” false positive** — chip green while local DB dirty (partially addressed; verify in prod).

12. **Cloud sync initial clone data loss** — fixed in CloudSyncService; verify on namespace switch.

---

## Recommended direction (short)

| Priority | Action |
|----------|--------|
| **Now** | Paprwork: send `user_id` + `external_user_id` (same Parse objectId) on all Memory/message writes |
| **Verify** | Memory: memory resolver copies top-level user ids like search does |
| **Later** | Login-time DeveloperUser provisioning pointing at real `_User`, or migration for existing shadows |
| **Don’t assume** | Email + external_user_id will ever link accounts without new server API |

---

## Key files (Paprwork)

| File | Role |
|------|------|
| `src/gateway/utils/paprUserId.ts` | Parse objectId for acting user |
| `src/gateway/utils/memoryScopeResolver.ts` | Memory ACL + `external_user_id` spread |
| `src/gateway/utils/cloudActingUser.ts` | Cloud API acting user |
| `src/core/tools/paprMemory.ts` | Agent memory tools |
| `src/electron/ipc/paprLogin.ts` | Signup, profile, API key |

## Key files (Memory server)

| File | Role |
|------|------|
| `services/cloud_acting_user.py` | Real Parse user for cloud ops |
| `services/user_utils.py` | `resolve_end_user_id`, DeveloperUser lookup |
| `routers/v1/user_routes.py` | `create_user_core`, shadow user creation |
| `services/auth_utils.py` | API key → org owner; user resolution orchestration |

---

## One-sentence summary

**Paprwork identifies logged-in users to Cloud with their real Parse account, but Memory treats them as third-party `external_id` strings and may create shadow users — fix by sending `user_id` on Memory calls and optionally provisioning DeveloperUser at login; email does not connect anything today.**
