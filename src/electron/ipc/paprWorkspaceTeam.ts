/**
 * Workspace team management — list members and send invites via dashboard APIs.
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

function normalizeMember(raw: NonNullable<DashboardMembersResponse["members"]>[number]): WorkspaceMember | null {
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

export interface WorkspaceInviteInput {
  sessionToken: string;
  workspaceId: string;
  organizationId: string;
  organizationName: string;
  workspaceName: string;
  inviterId: string;
  inviterName: string;
  inviterImageUrl?: string;
  email: string;
}

export interface WorkspaceInviteResult {
  email: string;
  inviteLink: string;
  alreadyMember?: boolean;
  skipped?: boolean;
}

function buildFallbackInviteLink(input: {
  workspaceId: string;
  organizationId: string;
  organizationName: string;
  workspaceName: string;
  inviterId: string;
  inviterName: string;
  email: string;
}): string {
  const token = `${input.workspaceId}-${input.inviterId}`;
  const params = new URLSearchParams({
    token,
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    organizationName: input.organizationName,
    inviterId: input.inviterId,
    inviterName: input.inviterName,
    workspaceName: input.workspaceName,
    email: input.email,
  });
  return `${PAPR_PLATFORM_URL}/invite?${params.toString()}`;
}

export async function sendWorkspaceInvite(
  input: WorkspaceInviteInput,
  existingMemberEmails: ReadonlySet<string>,
): Promise<WorkspaceInviteResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("Enter a valid email address");
  }

  if (existingMemberEmails.has(email)) {
    return {
      email,
      inviteLink: "",
      alreadyMember: true,
      skipped: true,
    };
  }

  const inviteLink = buildFallbackInviteLink({
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    organizationName: input.organizationName,
    workspaceName: input.workspaceName,
    inviterId: input.inviterId,
    inviterName: input.inviterName,
    email,
  });

  const response = await fetch(`${PAPR_PLATFORM_URL}/api/send-invite-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Session-Token": input.sessionToken,
    },
    body: JSON.stringify({
      email,
      inviterName: input.inviterName,
      inviterImage:
        input.inviterImageUrl ||
        "https://storage.googleapis.com/papr-assets/default-avatar.png",
      organizationName: input.organizationName,
      inviteLink,
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Failed to send invite (${response.status})`);
  }

  return { email, inviteLink };
}
