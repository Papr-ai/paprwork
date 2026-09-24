# Mini-app sharing: workspace members → signed-in non-members

**Status:** Planning — builds on Shawkat’s **“Specific people”** work (not necessarily merged to your branch yet).

**Last updated:** 2026-09-23

---

## Product goal

Today (after Shawkat’s PRs), publishers can share a mini-app with a **subset of workspace members** (“Specific people”). We want the same **signed-in Papr user** experience for people **outside the workspace**:

1. **Named people** — share by **email address** (must sign in; need not be workspace members).
2. **Domain rule** — “Anyone signed in with **`@client.com`**” (corporate domain gate, not workspace membership).

Out of scope for this doc: anonymous/public link access (already separate audiences); row-level DB scoping (`src/core/utils/shareScope.ts` — per-recipient query construction) unless product explicitly ties it to audience.

---

## Baseline: Shawkat “people” audience (merge first)

**Commits (reference):** `e4b7bf7f`, `ba472bc4`, merge `5026515b` (`fix/share-people-allowlist`).

### UX

- New share audience **`people`** (“Specific people”) alongside private / team / public / link.
- **`SharePeoplePicker`**: Google Docs–style chips; roster from **`papr:list-workspace-members`** only.
- Stored value: **`allowedUserIds`** (Parse `_User.objectId`), not display handles.

### Publish model

- **`people`** maps to cloud **`loginAccess: "team"`** on the memory server — **no new ACL principal type**.
- Consequence: memory authorizes **every workspace member**; the **gateway** narrows to `allowedUserIds`.

### Enforcement (security boundary)

- **`applyPeopleAllowlist`** in `src/gateway/services/appRuntime/cloudAppPeopleAccess.ts`.
- Called from **`CloudAppHostService.resolveAccess()`** (single chokepoint for `/api/access`, DB, jobs, files).
- Rules:
  - Empty / absent `allowedUserIds` ⇒ **not restricted** (same as whole workspace — avoids breaking existing team apps).
  - Publisher / owner always allowed.
  - Denial strips **both** read and write.

### Persistence

- **`allowedUserIds`** on local cloud publish prefs; PATCH publish-config in gateway; passed through **`sharingToAudienceModel`** / **`useCloudPublish`**.

### Before extending

Ensure this baseline is **merged and shipped** so non-member work extends one model instead of forking.

---

## New requirement: signed-in non-members

### Use cases

| Scenario | Publisher intent |
|----------|------------------|
| Agency shares dashboard with client PM | Add `pm@client.com` — not in agency workspace |
| Partner portal | Any `@partner.com` user with a Papr account |
| Mixed roster | Some workspace members + external emails + optional domain |

### Critical architecture difference

**Workspace subset (“people” today)** works because callers are already **team-authorized** at the memory layer; the gateway only **filters down**.

**Non-members are blocked at the memory layer** if publish stays `loginAccess: "team"`. You cannot fix that with gateway allowlist alone — they never get past cloud ACL.

So non-member sharing requires an explicit decision on **cloud ACL + gateway rules** together.

---

## Recommended approach (draft)

Treat “external audience” as a **second dimension** on the share model, not only more chips in the workspace picker.

### Audience modes (proposed)

Extend **`ShareAudienceModel`** (or adjacent prefs) with:

```typescript
// Illustrative — names TBD in implementation
type ExternalAudienceMode = "off" | "emails" | "domains" | "emails_and_domains";

interface ShareAudienceModel {
  audience: ShareAudience; // still includes "people" for UX
  allowedUserIds?: string[];      // workspace members (existing)
  allowedEmails?: string[];         // normalized lower-case emails
  allowedEmailDomains?: string[];   // e.g. ["client.com"] — no @, no wildcards
  externalAudience?: ExternalAudienceMode;
}
```

**Sign-in:** All modes require **verified** identity (`MiniAppCallerIdentity.userId` + **`email`** from server — see `VERIFIED_CALLER_EMAIL_PARAM` in `miniAppAccess.ts`). Never trust client-supplied email for authorization.

### Cloud publish mapping (must be chosen)

| Option | Memory visibility | Pros | Cons |
|--------|-------------------|------|------|
| **1. Public + require sign-in + gateway ACL** | `public`, `requireSignIn: true` | No memory ACL migration | Broad cloud surface; rely 100% on gateway |
| **2. Link + sign-in + gateway ACL** | link + token | Familiar link flow | Link leakage vs email/domain rules |
| **3. New memory ACL / explicit principals** | Server-side user/domain list | Correct at source | Memory API + migration work |

**Recommendation for v1:** Option **1** or **2** plus **strict gateway module** (below), unless memory team can ship explicit external principals quickly.

Document the chosen mapping in publish service and drift detection (`cloudPublishDrift.ts`) when implemented.

### Gateway enforcement (extend `cloudAppPeopleAccess`)

New function (name TBD), same chokepoint as `applyPeopleAllowlist`:

```text
allow if owner/publisher
else if not logged in → deny (sign_in_required)
else if allowedUserIds non-empty AND caller userId in list → allow
else if allowedEmails non-empty AND verified email in list → allow
else if allowedEmailDomains non-empty AND domain(verified email) in list → allow
else if only workspace subset configured (legacy people) → existing isUserAllowedByAudienceModel
else → deny (not_in_allowlist)
```

**Domain rules:**

- Normalize: lowercase, strip leading `@`, reject empty and **personal domains** (`PERSONAL_EMAIL_DOMAINS` in `provisioningDefaults.ts`) unless product explicitly allows.
- Subdomains: decide v1 — **exact match on registrable domain** vs `endsWith('.' + domain)` (document choice; default exact label match to avoid `@evil.client.com` via `client.com` unless subdomain allowlist is intended).

**Email rules:**

- Match **verified** email only (Auth0 / Parse profile as resolved today on cloud host).
- Optional at publish time: resolve email → `userId` for display in picker; **authorization should still prefer verified email** so renames/merges do not desync.

### UI (draft)

- **Share sheet** — sections:
  1. **People in this workspace** (existing picker).
  2. **Other people (email)** — type email, chip list; optional “invite to Papr” copy if no account (no access until they sign up with that email).
  3. **Domain** — one or more domains; helper text: “Must sign in with an address at this domain.”
- Validation before publish: at least one of member ids, emails, or domains when audience is “Specific people” (or split into sub-toggle).
- Do **not** silently fall back to **team** when external list is empty — distinguish “whole workspace” vs “misconfigured external share”.

### APIs / backend

| Need | Notes |
|------|--------|
| Resolve email → user | Parse or GraphQL lookup; rate-limit; audit log |
| Persist prefs | Extend `cloudPublishPrefs`, memory publish payload, PATCH handlers in `src/gateway/index.ts` |
| Desktop publish bar | `MiniAppPublishBar.tsx` + `useCloudPublish.ts` |
| Tests | Mirror `cloudAppPeopleAccess.test.ts` for email/domain; shareAudienceModel unit tests |

---

## Relationship to other “share” concepts

| Concept | Purpose |
|---------|---------|
| **`ShareAudience` / `allowedUserIds`** | Who may open the **app** (ACL) |
| **`shareScope.ts`** | **Row-level** data visibility inside shared DBs for a recipient |
| **Integration vault `allowedUserIds`** (`cloudReposScope.ts`) | Who may use an integration key — precedent for member allowlists, not app ACL |

Non-member app audience does **not** automatically change DB row scoping; if product needs “external user sees only their rows,” that remains **`shareScope`** / per-user isolation (`perUserIsolation` on publish).

---

## Implementation checklist (when prioritized)

1. [ ] Merge Shawkat **`people`** + allowlist persistence + gateway enforcement.
2. [ ] Product pick: memory visibility for external audience (table above).
3. [ ] Extend prefs + publish + drift for `allowedEmails` / `allowedEmailDomains`.
4. [ ] Implement **`applyExternalAudience`** (or unified **`applyShareAudience`**) in cloud host + local preview gate if needed.
5. [ ] UI: email chips + domain field + copy; lazy user lookup.
6. [ ] Tests + agent docs (`CLOUD_VS_DESKTOP_GUIDE.md`, system prompt if agents publish apps).
7. [ ] Security review: no client-trusted email; domain squatting; link+public leakage.

---

## Related docs & files

| Item | Location |
|------|----------|
| Share audience model (main) | `src/core/utils/shareAudienceModel.ts` |
| Shawkat branch model | `git show ba472bc4:src/core/utils/shareAudienceModel.ts` |
| People allowlist | `git show ba472bc4:src/gateway/services/appRuntime/cloudAppPeopleAccess.ts` |
| Publish prefs | `ui/utils/cloudPublishPrefs.ts`, `cloudSharingSettings.ts` |
| Workspace roster IPC | `papr:list-workspace-members` in `paprLogin.ts` |
| Cloud publish drift | `src/gateway/services/cloudPublishDrift.ts` |
