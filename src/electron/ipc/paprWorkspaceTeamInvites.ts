/**
 * Workspace invite helpers (Electron IPC only).
 * Delegates to papr-dev-platform /api/workspace/sendInvite for full parity
 * with dashboard Settings → People → Add members.
 */

import { getPaprTeamPlatformUrl } from "../../core/utils/paprPlatformUrl.js";

export interface WorkspaceInviteInput {
  sessionToken: string;
  workspaceId: string;
  email: string;
  role?: string;
}

export interface WorkspaceInviteResult {
  email: string;
  inviteLink: string;
  inviteId?: string;
  alreadyMember?: boolean;
  alreadyPending?: boolean;
  skipped?: boolean;
}

interface SendInviteApiResponse {
  success?: boolean;
  email?: string;
  inviteLink?: string;
  inviteId?: string;
  error?: string;
}

export async function sendWorkspaceInvite(
  input: WorkspaceInviteInput,
): Promise<WorkspaceInviteResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("Enter a valid email address");
  }

  const platformUrl = getPaprTeamPlatformUrl();
  const response = await fetch(`${platformUrl}/api/workspace/sendInvite`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Session-Token": input.sessionToken,
    },
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      email,
      role: input.role ?? "member",
    }),
  });

  const body = (await response.json().catch(() => ({}))) as SendInviteApiResponse;

  if (response.status === 409) {
    const message = body.error ?? "Invite could not be sent";
    if (message.includes("already a member")) {
      return {
        email,
        inviteLink: "",
        alreadyMember: true,
        skipped: true,
      };
    }
    if (message.includes("pending invite")) {
      return {
        email,
        inviteLink: "",
        alreadyPending: true,
        skipped: true,
        inviteId: body.inviteId,
      };
    }
    throw new Error(message);
  }

  if (!response.ok) {
    throw new Error(body.error || `Failed to send invite (${response.status})`);
  }

  if (!body.email || !body.inviteLink) {
    throw new Error("Invite API returned an incomplete response");
  }

  return {
    email: body.email,
    inviteLink: body.inviteLink,
    inviteId: body.inviteId,
  };
}
