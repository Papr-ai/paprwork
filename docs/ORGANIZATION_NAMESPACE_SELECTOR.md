# Organization & Namespace Selector

**Date:** 2026-04-12  
**Feature:** Multi-organization support with org/namespace selector UI  
**Status:** ✅ Implemented

## Problem

Users who are members of multiple organizations (workspaces) could only see namespaces from one organization. The namespace dropdown only showed namespaces from the organization that was selected during initial login, making it impossible to switch between different teams/companies.

**User Experience Before:**
- Login to Papr ✅
- Get provisioned to default org/namespace ✅
- Namespace dropdown shows only 1-3 namespaces from that org
- Can't see namespaces from other orgs you're a member of ❌
- No way to switch organizations ❌

## Solution

Added a hierarchical selector system:
1. **Organization Selector** - Choose which company/team to work with
2. **Namespace Selector** - Choose which environment within that org (production, development, staging, etc.)

When you switch organizations, the namespace list automatically reloads to show namespaces from the new org.

## Architecture

### GraphQL Queries

**1. Get ALL organizations user has access to:**
```graphql
query GetUserOrganizations($userId: ID!) {
  organizationFollowers(where: { 
    follower: { have: { objectId: { equalTo: $userId } } }
    is_active: { equalTo: true }
  }) {
    edges {
      node {
        organization {
          objectId
          name
        }
        role
      }
    }
  }
}
```

This uses `organizationFollowers` (the join table) to find ALL orgs where the user is a member, not just orgs they own.

**2. Get namespaces for selected organization:**
```graphql
query GetOrgNamespaces($orgId: ID!) {
  namespaces(where: { 
    organization: { have: { objectId: { equalTo: $orgId } } }
    is_active: { equalTo: true }
  }) {
    edges {
      node {
        objectId
        name
        environment_type
      }
    }
  }
}
```

### IPC Handlers

**Backend:** `src/electron/ipc/paprLogin.ts`

1. **`papr:list-organizations`** - Returns all orgs user is a member of
2. **`papr:switch-organization`** - Updates active org, clears namespace, triggers reload
3. **`papr:list-namespaces`** - Returns namespaces for active org (existing)
4. **`papr:switch-namespace`** - Switches namespace, gets/creates API key (existing)

### Data Flow

```
User selects org → 
  IPC: papr:switch-organization → 
    Update profile.organizationId → 
      Emit papr:organization-changed → 
        UI reloads namespaces →
          User selects namespace →
            IPC: papr:switch-namespace →
              Get/create API key for namespace →
                Store PAPR_API_KEY
```

## User Interface

### Organization Selector (new)
```
┌─────────────────────────────────┐
│ 👥 Organization                 │
│ ┌─────────────────────────────┐ │
│ │ Papr AI Inc (owner)       ▼ │ │
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

Shows:
- Organization name
- User's role in parentheses (owner, admin, member)
- Only shown if user has 2+ organizations

### Namespace Selector (enhanced)
```
┌─────────────────────────────────┐
│ 📁 Namespace                    │
│ ┌─────────────────────────────┐ │
│ │ Production              ▼   │ │
│ └─────────────────────────────┘ │
│ API calls will use Production   │
└─────────────────────────────────┘
```

Shows:
- Namespace name
- Environment type in parentheses (production, development, staging)
- Confirmation message below dropdown
- Only shown if organization has 1+ namespaces

## User Experience

### Before (Single Org)
```
Connected to Papr
Logged in as user@example.com

┌─────────────────────────────────┐
│ 📁 Namespace                    │
│ Development (development)       │
│ Production (production)         │
└─────────────────────────────────┘
```

### After (Multi Org)
```
Connected to Papr
Logged in as user@example.com

┌─────────────────────────────────┐
│ 👥 Organization                 │
│ Papr AI Inc (owner)             │ ← NEW
│ Acme Corp (admin)               │ ← NEW
│ Startup XYZ (member)            │ ← NEW
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ 📁 Namespace                    │
│ Development (development)       │
│ Production (production)         │
└─────────────────────────────────┘
```

## Implementation Details

### Files Changed

1. **`src/electron/ipc/paprLogin.ts`**
   - Added `GET_USER_ORGANIZATIONS` GraphQL query
   - Added `papr:list-organizations` handler
   - Added `papr:switch-organization` handler
   - Enhanced `papr:list-namespaces` to work with active org

2. **`src/electron/preload.cjs`**
   - Added `listOrganizations()` method
   - Added `switchOrganization()` method
   - Added `onOrganizationChanged()` event listener

3. **`ui/types/electron.d.ts`**
   - Added TypeScript types for new methods

4. **`ui/components/Settings/PaprLoginSection.tsx`**
   - Added `Organization` interface
   - Added organization state management
   - Added `loadOrganizations()` method
   - Added `handleSwitchOrganization()` method
   - Added organization selector UI (rendered before namespace selector)
   - Enhanced event listeners for org changes
   - Clear org/namespace state on logout

### State Management

```typescript
interface Organization {
  id: string;
  name: string;
  role?: string; // "owner" | "admin" | "member"
}

interface Namespace {
  id: string;
  name: string;
  environmentType?: string; // "production" | "development" | "staging"
}
```

**Profile storage:**
```typescript
{
  userId: string;
  email: string;
  sessionToken: string;
  organizationId: string;        // Active org
  activeNamespaceId: string;     // Active namespace
  activeNamespaceName: string;
}
```

## API Key Management

When switching namespaces, the system:
1. Checks if namespace already has an API key
2. If yes: retrieves and stores it as `PAPR_API_KEY`
3. If no: creates a new API key and stores it

**API Key Format:**
```
sk-org-{organizationId}-namespace-{namespaceId}-{32-random-chars}
```

Example:
```
sk-org-wVPc17GuOO-namespace-sZCTT5QCea-6bTRICQOueQr5TsJ20loOikwR8io1rYn
```

## Edge Cases

### Single Organization
- Organization selector is **hidden** (not needed)
- Only namespace selector is shown
- Cleaner UI for simple cases

### No Namespaces
- Namespace selector is **hidden**
- Shows only login status and logout button

### Organization Switch
- Namespace selector **clears** and reloads
- Active namespace **resets** (first namespace in new org)
- API key **switches** to new namespace's key

### Network Errors
- Shows error message inline
- Dropdown remains usable
- Can retry by switching again

## Testing

### Test Case 1: Multi-org User
1. ✅ Login with account that's member of 3+ organizations
2. ✅ Verify organization selector appears
3. ✅ Verify all organizations listed with correct roles
4. ✅ Switch between organizations
5. ✅ Verify namespace list reloads for each org
6. ✅ Verify API key updates when switching namespaces

### Test Case 2: Single-org User
1. ✅ Login with account that's member of 1 organization
2. ✅ Verify organization selector is **hidden**
3. ✅ Verify namespace selector works normally

### Test Case 3: Logout/Login
1. ✅ Logout from Papr
2. ✅ Verify org/namespace state cleared
3. ✅ Login again
4. ✅ Verify organizations reload correctly

## Backwards Compatibility

Existing users who logged in before this feature:
- Will see organization selector if they're in multiple orgs
- Will continue using their existing organization/namespace
- No migration needed (profile already has `organizationId`)

## Future Enhancements

1. **Workspace selector** - Add another level (org → workspace → namespace)
2. **Default org preference** - Remember user's preferred org across sessions
3. **Quick switch keyboard shortcut** - Cmd+Shift+O for org, Cmd+Shift+N for namespace
4. **Org/namespace search** - Filter dropdown for users with many orgs
5. **Recent org list** - Show recently used orgs at top

## Related

- [PAPR_LOGIN_INTEGRATION.md](./PAPR_LOGIN_INTEGRATION.md) - Initial Papr login feature
- [PAPR_PROFILE_SYNC.md](./PAPR_PROFILE_SYNC.md) - Profile data syncing
- Enhancement 20 (CLAUDE.md) - Papr login deep link flow
- Enhancement 22 (CLAUDE.md) - Papr profile sync

## GraphQL Schema Context

**Parse Classes:**
- `_User` - End users with Auth0 authentication
- `Organization` - Companies/teams (has `owner`, `workspace`, `default_namespace`)
- `organization_follower` - Join table (links users to orgs with roles)
- `Namespace` - Environments within organizations (production, development, staging)
- `APIKey` - API keys scoped to specific namespaces

**Relationships:**
- User → organization_follower → Organization (many-to-many)
- Organization → Namespace (one-to-many)
- Namespace → APIKey (one-to-many)
