/**
 * Gateway API — app roles (proxied to memory /v1/cloud/apps/{id}/access).
 */

import type { AccessPatch, AppAccess } from "./appRolesModel";

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown; error?: unknown };
    const msg = body.detail ?? body.error;
    if (typeof msg === "string" && msg) return msg;
  } catch {
    /* not JSON */
  }
  return `Request failed (${res.status})`;
}

/** null when the app isn't published or the caller has no access. */
export async function fetchAppAccess(appId: string): Promise<AppAccess | null> {
  const res = await fetch(`${GATEWAY}/api/cloud/apps/${appId}/access`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AppAccess;
}

export async function saveAppAccess(
  appId: string,
  patch: AccessPatch,
): Promise<AppAccess> {
  const res = await fetch(`${GATEWAY}/api/cloud/apps/${appId}/access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AppAccess;
}
