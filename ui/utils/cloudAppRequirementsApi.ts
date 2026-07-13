/**
 * Gateway API — read/write app credential requirements (requirements.json).
 */

import type { RequiredKeySpec } from "../../../src/core/types/bundles";

const GATEWAY =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export async function fetchAppRequirements(
  appId: string,
): Promise<RequiredKeySpec[]> {
  const res = await fetch(`${GATEWAY}/api/cloud/apps/${appId}/requirements`);
  if (!res.ok) {
    throw new Error(`Failed to load requirements (${res.status})`);
  }
  const body = (await res.json()) as { requirements?: RequiredKeySpec[] };
  return body.requirements ?? [];
}

export async function saveAppRequirements(
  appId: string,
  requirements: RequiredKeySpec[],
): Promise<RequiredKeySpec[]> {
  const res = await fetch(`${GATEWAY}/api/cloud/apps/${appId}/requirements`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requirements }),
  });
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? `Failed to save requirements (${res.status})`);
  }
  const saved = (await res.json()) as { requirements?: RequiredKeySpec[] };
  return saved.requirements ?? requirements;
}
