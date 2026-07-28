/**
 * Workspace team management — re-exports shared fetch logic for Electron IPC.
 */

export {
  fetchWorkspaceMembers,
  type WorkspaceMember,
  type WorkspaceMemberUser,
} from "../../core/utils/paprWorkspaceTeam.js";

export {
  sendWorkspaceInvite,
  type WorkspaceInviteInput,
  type WorkspaceInviteResult,
} from "./paprWorkspaceTeamInvites.js";
