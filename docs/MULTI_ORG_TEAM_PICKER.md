# Multi-Org Team Picker (v2.2.3)

The Profile **Team** picker now lists namespaces from **every organization** attached to the user's workspace, not just the primary org.

## Problem (before v2.2.3)

A Papr workspace can hold multiple Parse organizations (each org has its own `workspace` pointer). The team picker only queried the workspace's **primary** organization, so users with 3 orgs might see 1 namespace instead of 16.

Selecting a team in a non-primary org could also **silently bounce back** to the original workspace because:

1. `syncActiveWorkspaceOrganization` treated any `profile.organizationId` differing from the primary org as drift and rewrote it.
2. That triggered a competing gateway workspace switch, which superseded the user's intended switch.

## Fix

1. **Listing:** New `GET_WORKSPACE_ORGANIZATIONS` GraphQL query and `papr:list-all-namespaces` IPC handler unions namespaces from the primary org plus every org linked to each workspace. Cache-first with background refresh; partial results on org failure.
2. **Switching:** Organization sync no longer overwrites the user's selected org when switching teams within a multi-org workspace. Gateway switch races are avoided.

## Testing

- Open Settings → Profile → Team picker with an account that has multiple orgs on one workspace.
- Verify all namespaces appear grouped by org.
- Switch to a namespace in a non-primary org — workspace should stay on that selection after reload.

## Related Files

- `src/electron/ipc/paprLogin.ts` — `list-all-namespaces`, org resolution
- `ui/components/Settings/PaprLoginSection.tsx` — team picker UI
- `tests/papr-auth-mode.test.ts` — auth/org tests
