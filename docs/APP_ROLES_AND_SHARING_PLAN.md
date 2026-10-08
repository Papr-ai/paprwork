# App roles and sharing: co-owners and permission-aware sharing

**Status:** In progress. Pull-first on Publish and Propose is done; step 1 (role resolution) is built and tested, not deployed.
**Model:** GitHub repository permissions, adapted for Papr apps.
**Goals:**
1. Several people can be owners of an app and publish changes without approval.
2. Sharing gives each audience its own role: the workspace, specific people, and community or link.

---

## 1. Roles

Each role includes everything in the roles above it.

| Role | GitHub equivalent | Use the app | Copy the code | Propose changes | Publish directly | Approve proposals | Manage access, approval rule, unpublish |
|---|---|---|---|---|---|---|---|
| **Viewer** | none | ✓ | | | | | |
| **Contributor** | Read | ✓ | ✓ | ✓ (needs approval) | | | |
| **Maintainer** | Write | ✓ | ✓ | ✓ | ✓ | ✓ | |
| **Admin** | Admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

- The publisher is the first Admin. Admins are equals: they can add or remove other Admins and unpublish. The **last Admin can't be removed**; ownership moves by adding a new Admin first.
- GitHub has no Viewer role (Read always includes the code). We need one for "use it, but don't see the code".

## 2. Where a role comes from (highest wins)

| Source | Stored as | Allowed roles |
|---|---|---|
| Publisher | `userId` on the published record | Admin (always) |
| Workspace base role | `workspaceRole` | none, Viewer, Contributor, Maintainer |
| Specific people | `grants: [{ userId? , email?, role }]` | Viewer to Admin |
| Community or link | `publicRole` | none, Viewer, Contributor (**never** Maintainer or Admin) |
| Groups | not in v1 | — |

- Workspace members never get more than Maintainer from the base role, so becoming an Admin is always a per-person decision.
- `email` grants resolve when that person signs in, the same way `allowedEmails` works today. There are no invitations to accept.
- A share link with a token gives `publicRole`. People without a grant get the higher of the workspace role and `publicRole`.

## 3. Approval rule (per app)

`approvalRule`:
- `contributors` (default): Contributors need approval; Maintainers and Admins publish directly.
- `everyone`: every change goes through a proposal, Admins included. This is GitHub's branch protection with no bypass.

## 4. Publishing directly: pull first, then the per-file check

**What already happens today (checked):**
- **Proposing with Pen** (`submit_cloud_app_pr`): pulls the publisher's latest first and stops if any file overlaps (`core/tools/cloudInstall.ts`, around line 297).
- **Proposing with the Send to owner button** (`POST /api/cloud/apps/changes` → `propose()`): does **not** pull first, even though the Pen tool's comment says "same as the Propose button". The proposal branches from the commit the copy is based on, and the server marks it "conflict" later if it's out of date. Bug: fix as part of this work.
- **Publishing as the owner:** does **not** pull first. The safety net is the app repo writer's per-file check: every uploaded file carries the hash of the version it was edited from (`parentHash`), and the writer rejects with 409 if that file changed on the cloud since (`appRepoWriter/parentHashVerify.ts`). The desktop then stops retrying and shows the conflict in the share bar for Get updates.

So nobody's file is ever silently overwritten today. What the per-file check misses:
- Someone else changed file A while you changed file B. Both publishes go through, and the combination was never run by anyone.
- Two people each add a new migration file (different names, so no file conflict), and the migrations' order on the server isn't the order either of them tested.

With one owner this rarely matters. With several Maintainers it will.

**Rule for v1:**
1. **Pull first, every time.** Publishing (Maintainer or Admin) and proposing (any role, button or Pen) both run Get updates first. If any file overlaps, stop and ask: Keep mine / Take theirs / merge. Nothing is sent until that's resolved.
2. **Keep the per-file 409** as the backstop for the moment between pulling and publishing.
3. **Migrations need the whole app up to date.** If the publish includes a new migration file, the writer also rejects it unless the copy has the latest published revision (`baseRevision`). A migration then always runs on top of the others it was tested with. Ordinary code changes don't need this, because step 1 already keeps the copy current.

This replaces the earlier idea of a whole-app `baseRevision` check on every publish. Pull-first plus the per-file check gives the same protection for code, with fewer "Get updates first" interruptions.

## 5. Database changes (breaking migrations)

There's nothing like this on GitHub. The rule:
- **Whoever publishes runs the migration on their own desktop**, under the breaking-migration hold (Phase 1–6 of the breaking-migration plan).
- Because of section 4, publishes always happen one after another, so two people can't run the same migration.
- A Contributor's proposal is applied by the Maintainer or Admin who approves it, using the existing proposal flow.

## 6. Proposals: any Maintainer or Admin can approve

**Today:** proposals are stored with `sourceUserId` set to the publisher. The approve and reject routes (`/apps/changes/{id}/approve`, `/reject`) only find a proposal when the caller **is** `sourceUserId` (`cloud_app_change_service._resolve_change_request`, `list_incoming_change_requests`).

**Change:**
- Find proposals by app (`sourceOrgId`, `sourceNamespaceId`, `appId`) rather than by publisher.
- Check the caller's role is at least Maintainer.
- The incoming list returns proposals for every app the caller maintains.
- Notifications (`_emit(..., to="owner")`) go to every Maintainer and Admin. Record who approved (`approvedBy`).

## 7. Migrating existing shares

Every existing published app gets roles computed from its current settings, so no one's access changes.

| Today | Becomes |
|---|---|
| Publisher | Admin |
| `visibility = team`, `codeAccess = off` | `workspaceRole = viewer` |
| `visibility = team`, `codeAccess = install` | `workspaceRole = contributor` |
| `allowedUserIds` / `allowedEmails` | one `grants` entry each: Contributor if `codeAccess = install`, otherwise Viewer |
| `allowedEmailDomains` | kept as is in v1 (role from `codeAccess`); later a domain grant |
| `visibility = public` / link | `publicRole` = Viewer, or Contributor if `codeAccess = install` |
| `visibility = private` | nothing besides the publisher |

- The server works out roles from the new fields when they exist, and from the old fields otherwise. No one-off migration script is needed.
- The old fields stay up to date while older desktops are still around (expand/contract).

## 8. Implementation

### Memory server
1. **`services/cloud_app_roles.py`** (new): `Role` enum, `resolve_caller_role(doc, caller_user_id, caller_email, is_workspace_member, share_token) -> Role`, and a fallback that works out roles from the old fields. This is the only place roles are worked out.
2. Replace the owner checks with role checks. Current owner-check counts: `cloud_app_runtime_service.py` (18), `cloud_app_change_service.py` (11), `cloud_routes.py` (10), `cloud_app_contribute_service.py` (8), `cloud_app_publish_service.py` (7). Each becomes `role >= X`.
3. `validate_access_*` returns a `role` field, keeping `canRead` and `canInstallCode` for older desktops.
4. Publish: accept publishes from Maintainers and Admins, not only the publisher. The writer rejects publishes that add a migration unless `baseRevision` is current (section 4).
5. Proposals: the lookup changes from section 6.
6. Sharing API: `PUT /apps/{id}/access` with `{ workspaceRole, publicRole, grants, approvalRule }`. Only Admins can call it, and it refuses to remove the last Admin.
7. Tests:
   - Role resolution for every combination of sources.
   - Working out roles from old fields for each row of section 7.
   - Can't remove the last Admin.
   - Community or link can never be given Maintainer.
   - A publish that adds a migration from an out-of-date copy is rejected.
   - A Maintainer who isn't the publisher can approve.

### Desktop (Paprwork)
1. Installed copies record their `role` when installed and when synced. A Maintainer or Admin sees **Publish**; a Contributor sees **Propose**.
2. Publish and Propose (button and Pen) both run Get updates first and stop on overlapping files. Publishing sends `baseRevision`.
3. Pen and agent tools (`core/tools`) read the role, so Pen proposes instead of publishing for Contributors.
4. The approvals inbox shows proposals for every app the user maintains.

### Share dialog (`ShareSheetBody.tsx`, `SharePeoplePicker.tsx`, `ui/utils/shareSheetModel.ts`)

**Today:** the sheet leads with the link, then three rows that are edited as steps: **Who can open it** (one choice from Only me / Workspace / Specific people / Anyone with the link / Community), **What they can do** (Use your app, or Use it or install a copy) and **API keys**. One audience gets one permission.

**New:** keep the link at the top and the API keys row as they are. Replace the Who and What rows with one **Who has access** row that opens a single "Manage access" step, like GitHub's:

```
Who has access
  Workspace              [ Contributor ▾ ]      none / Viewer / Contributor / Maintainer
  People                                         + Add by email or name
    Shawkat  shawkat@…   [ Maintainer ▾ ]  ✕     Viewer … Admin
    Sam      sam@…       [ Contributor ▾ ]  ✕
    You      (publisher)   Admin                 not editable
  Anyone with the link   [ Viewer ▾ ]            none / Viewer / Contributor
    ☐ Require Papr sign-in
    ☐ Give each person their own data
  List in Community      ☐                       uses the link role

  Advanced
    ☐ Require approval for everyone             Maintainers and Admins too
```

- **Role dropdowns** show a one-line description for each choice: Viewer "Use the app", Contributor "Copy the code and propose changes", Maintainer "Publish changes and approve proposals", Admin "Also manage access".
- **The People list** reuses the `SharePeoplePicker` search (workspace members and emails), with a role dropdown and a remove button per person.
- **The summary row** reads, for example, "Workspace: Contributor · 2 people · Link: Viewer".
- **The sign-in and own-data toggles** move under the link row. They only apply to link and Community visitors, as now.
- **Guards:** you can't remove the last Admin. Link and Community never offer Maintainer or Admin. Only Admins see the dialog as editable; everyone else sees it read-only with their own role.
- **The Propose sheet** (`CloudContributeBackPanel`) is shown to Contributors. Maintainers and Admins see Publish instead.
- **Existing apps:** the dialog opens showing the roles worked out from their current settings (section 7), so nothing appears to change until someone edits it.

The dialog can only save new roles once the sharing API exists (step 4). Until then it stays as it is.

## 9. Order of work

1. Memory server: role resolution, working out roles from old fields, and `validate_access` returning `role`. Read-only, no change in behaviour. **Ship.**
2. Memory server: role checks replace owner checks, and proposals open to Maintainers. **Ship.** A test with two users: Shawkat as Maintainer approves a proposal.
3. Memory server, then desktop: pull-first on publish and on the Propose button, the migration `baseRevision` check, and Publish vs Propose by role. Start with two desktops in Collab QA.
4. Memory server: the access API, then the share dialog.
5. Collab QA end to end: publisher, a second Admin, a Maintainer, a Contributor, a Viewer and a link visitor.

Steps 1–2 need no desktop release. Steps 3–4 need a Paprwork release.

## 10. Out of scope for v1
- Groups and teams.
- Triage and Maintain roles.
- Code owners per file.
- Invitations people must accept.
- Domain grants with a role (domain grants keep using `codeAccess` for now).
