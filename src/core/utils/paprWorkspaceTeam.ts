/**
 * Workspace team APIs shared by Electron IPC and the gateway agent tools.
 */

const PAPR_PLATFORM_URL = (
  process.env.PAPR_PLATFORM_URL || "https://dashboard.papr.ai"
).replace(/\/$/, "");

export interface WorkspaceMemberUser {
  objectId: string;
  email: string;
  displayName: string;
  profileImageUrl?: string;
  role: string;
}

export interface WorkspaceMember {
  objectId: string;
  user: WorkspaceMemberUser;
}

interface DashboardMemberUser {
  objectId: string;
  email?: string;
  displayName?: string;
  fullname?: string;
  profileimage?: { url?: string };
  socialProfilePicURL?: string;
  role?: { name?: string };
  allRoles?: Array<{ name?: string }>;
}

interface DashboardMembersResponse {
  members?: Array<{
    objectId: string;
    user: DashboardMemberUser;
  }>;
  error?: string;
}

/** Match dashboard PeopleSection — ignore Parse "follower" when owner/admin/member exists. */
const WORKSPACE_ROLE_PRIORITY = [
  "owner",
  "admin",
  "moderator",
  "member",
  "expert",
] as const;

function resolveWorkspaceRole(user: DashboardMemberUser): string {
  const roleNames =
    user.allRoles?.map((role) => role.name?.trim()).filter((name): name is string => Boolean(name)) ??
    [];

  for (const priority of WORKSPACE_ROLE_PRIORITY) {
    if (roleNames.includes(priority)) {
      return priority;
    }
  }

  const nonFollower = roleNames.filter((name) => name !== "follower");
  if (nonFollower.length > 0) {
    return nonFollower[0];
  }

  const primary = user.role?.name?.trim();
  if (primary && primary !== "follower") {
    return primary;
  }

  return "member";
}

function normalizeMember(
  raw: NonNullable<DashboardMembersResponse["members"]>[number],
): WorkspaceMember | null {
  const user = raw.user;
  if (!user?.objectId || !user.email) {
    return null;
  }

  const email = user.email.trim();
  const lower = email.toLowerCase();
  if (lower.startsWith("anon")) {
    return null;
  }

  const displayName =
    user.displayName?.trim() ||
    user.fullname?.trim() ||
    email;

  return {
    objectId: raw.objectId,
    user: {
      objectId: user.objectId,
      email,
      displayName,
      profileImageUrl: user.profileimage?.url || user.socialProfilePicURL,
      role: resolveWorkspaceRole(user),
    },
  };
}

export async function fetchWorkspaceMembers(
  sessionToken: string,
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  const url = new URL(`${PAPR_PLATFORM_URL}/api/workspace/members`);
  url.searchParams.set("workspaceId", workspaceId);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-Parse-Session-Token": sessionToken,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Failed to load workspace members (${response.status})`);
  }

  const data = (await response.json()) as DashboardMembersResponse;
  const members = data.members ?? [];
  return members
    .map(normalizeMember)
    .filter((member): member is WorkspaceMember => member !== null);
}

const PARSE_GRAPHQL_URL =
  process.env.PARSE_GRAPHQL_URL ?? "https://server.papr.ai/graphql";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID ?? "671e705a-f735-4ec0-8474-15899a475440";

interface NamespaceWorkspaceGraphQLResponse {
  data?: {
    namespace?: {
      objectId?: string;
      organization?: {
        workspace?: { objectId?: string };
        workSpace?: { objectId?: string };
      };
    };
  };
  errors?: unknown[];
}

/** Resolve Papr workspace id from a namespace id (cloud app host + team apps). */
export async function resolveWorkspaceIdForNamespace(
  sessionToken: string,
  namespaceId: string,
): Promise<string | null> {
  const trimmedNamespaceId = namespaceId.trim();
  if (!trimmedNamespaceId) {
    return null;
  }

  const response = await fetch(PARSE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Session-Token": sessionToken,
    },
    body: JSON.stringify({
      query: `
        query GetNamespaceWorkspace($namespaceId: ID!) {
          namespace(id: $namespaceId) {
            objectId
            organization {
              workspace { objectId }
              workSpace { objectId }
            }
          }
        }
      `,
      variables: { namespaceId: trimmedNamespaceId },
    }),
  });

  if (!response.ok) {
    return null;
  }

  const json = (await response.json()) as NamespaceWorkspaceGraphQLResponse;
  if (json.errors?.length) {
    return null;
  }

  const org = json.data?.namespace?.organization;
  const workspaceId =
    org?.workspace?.objectId?.trim() || org?.workSpace?.objectId?.trim();
  return workspaceId || null;
}
