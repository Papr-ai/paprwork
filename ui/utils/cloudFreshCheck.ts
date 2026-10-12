/**
 * One fresh "is the web ahead of this computer?" check, right before a
 * publish. Same gateway call the sync chip uses on its timer; a failed check
 * answers false so publishing still goes through its normal per-file guard.
 */

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export async function fetchWebIsAhead(appId: string, collaborator: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY}/api/apps/${encodeURIComponent(appId)}/remote-code-status`);
    if (!res.ok) return false;
    const body = (await res.json()) as {
      upToDate?: boolean;
      checkFailed?: boolean;
      publisherUpdatesAvailable?: boolean;
    };
    if (body.checkFailed) return false;
    return collaborator ? body.publisherUpdatesAvailable === true : body.upToDate === false;
  } catch {
    return false;
  }
}
