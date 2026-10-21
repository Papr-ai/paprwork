/**
 * What to tell a collaborator whose linked copy the publisher stopped sharing.
 * The server's 403 is a final answer: updates pause until access comes back.
 */
export type UpdatesPausedReason = "no_access" | "code_access_off" | "share_mode" | "denied";

export function updatesPausedMessage(reason: string | undefined, publisher = "The publisher"): string {
  switch (reason) {
    case "code_access_off":
      return `${publisher} turned off code sharing for this app, so updates are paused. Ask them to turn "Edit the code" back on.`;
    case "no_access":
      return `${publisher} changed who can access this app, so updates are paused. Ask them to share it with you again.`;
    case "share_mode":
      return `${publisher} changed how this app is shared, so updates are paused. Ask them to share it with your team again.`;
    default:
      return `${publisher} changed this app's share settings, so updates are paused. Ask them to update your access.`;
  }
}
