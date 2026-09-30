# Company & tenant provisioning (planning)

**Status:** Planning only — not implemented as a single end-to-end flow in Paprwork desktop/web as of this doc.

**Last updated:** 2026-09-23

---

## Why this doc exists

Agency and enterprise onboarding sometimes need to **stand up a new company (tenant)** before anyone logs in, or align desktop login provisioning with what Auth0 Post-Login Action 3 already does for corporate email. Today those paths are **split** and easy to conflate.

Do **not** mix these layers:

| Layer | What it is | Typical identifiers |
|--------|------------|---------------------|
| **Legacy company / SSO** | Parse `Company`, Auth0 Organization, primary `WorkSpace` (`companyId`), org membership, workspace people, JWT claims (`isCompanyAdmin`, etc.) | Company id, Auth0 org id, workspace id |
| **Paprwork / Memory tenant** | GraphQL **Organization**, **Namespace**, **API key** (`PAPR_API_KEY`) | `orgId`, `namespaceId`, API key |

Desktop and web provisioning today focus on the **Memory tenant** layer. Auth0 Action 3 (corporate signup) focuses on the **legacy company / SSO** layer. Neither alone gives you “new company + dev org + namespace + key” in one call.

---

## Provisioning levels (product)

| Level | Name | Creates |
|--------|------|---------|
| **A** | **New company (tenant)** | Parse Company + Auth0 org + primary workspace + (policy) dev GraphQL org + namespace + API key |
| **B** | **New workspace in existing company** | Reuse company / Auth0 org; new workspace (+ org/namespace policy per product) |
| **C** | **Namespace / key only** | GraphQL org already exists; add namespace and/or rotate key |

---

## What Paprwork does today

### Desktop (`src/electron/ipc/paprLogin.ts`)

- **`assessProvisioningNeeds`** → **`resolveProvisioningPlan`** (`src/core/papr/provisioningDefaults.ts`).
- Plan kinds: `none` | `namespace_only` | `org_and_namespace` | `deferred`.
- **`provisionNewOrgNamespace`**: GraphQL org + namespace + API key; may call Parse **`createWorkspace`** when no workspace exists (often **without** `companyId`).
- **`deferred`**: fail closed when workspace org state is **unknown** or developer org lookup failed — avoids repointing a shared workspace at a new personal org.

### Web (`papr-dev-platform` — `provisionWorkspaceAccount.ts`)

- **`createOrganizationWithNamespace`** + API key for dashboard users.

### Auth0 Post-Login Action 3 (tenant config, not in this repo)

Typical corporate flow (user-pasted reference):

1. Create Parse **Company** (REST).
2. **`createWorkspace`** with **`companyId`**.
3. Create Auth0 **Organization**, metadata, connections (`assign_membership_on_login`).
4. Add member / **`addPeopleToWorkspace`**.

Action 3 runs **on login** when `completedProfileSignup !== true` and email domain matches company rules. It does **not** create GraphQL dev org/namespace/key.

---

## Gaps

1. **No single `provisionCompanyTenant` API** used by desktop, web, and Auth0.
2. **Desktop never creates Parse Company or Auth0 org** — only Memory tenant + optional bare workspace.
3. **Action 3 never creates GraphQL org/namespace/key** — user still needs Papr login provisioning or manual setup.
4. **Pre-login / agency provisioning** cannot rely on Action 3 (domain is tied to the user who logs in).

---

## Proposed future contract (sketch)

```text
provisionCompanyTenant(input):
  companyName, primaryDomain?, adminEmail?
  → companyId, auth0OrgId?, workspaceId
  → developerOrgId, namespaceId, apiKey (or deferred + webhook)
```

**Requirements to nail before implementation:**

- Idempotency (same domain / same admin re-run).
- Dedup with Action 3 (same corporate domain signing up twice).
- Who may call it (master key, internal admin, billing contract).
- Mapping **workspace** ↔ **namespace** when level B vs C.
- **`WorkspaceOrganizationState: "unknown"`** handling — same fail-closed rules as `resolveProvisioningPlan`.

---

## Related code

| Area | Path |
|------|------|
| Provisioning plan | `src/core/papr/provisioningDefaults.ts` |
| Desktop login + provision | `src/electron/ipc/paprLogin.ts` |
| Workspace members / invites | `papr:list-workspace-members`, `papr:invite-workspace-member` |
| Multi-org picker | `docs/MULTI_ORG_TEAM_PICKER.md` |

---

## Open questions

- Should level **A** always create both legacy company **and** GraphQL org, or only for certain SKUs?
- When user joins existing Auth0 org via SSO, do we skip `org_and_namespace` and only ensure namespace/key?
- Agency “create tenant for client.com” without any user login — Action 3 bypass + admin API only?
