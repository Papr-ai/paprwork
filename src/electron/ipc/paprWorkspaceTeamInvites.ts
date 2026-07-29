/**
 * Workspace invite email helpers (Electron IPC only).
 */

const PAPR_PLATFORM_URL = (
  process.env.PAPR_PLATFORM_URL || "https://dashboard.papr.ai"
).replace(/\/$/, "");

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
