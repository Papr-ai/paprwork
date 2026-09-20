/**
 * Owner incoming contribute-back proposals (memory server via gateway).
 */

const GATEWAY =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export interface CloudChangeRequest {
  id: string;
  sourceAppId: string;
  sourceSlug?: string;
  installedAppId: string;
  title: string;
  description: string;
  status: "preparing" | "pending" | "approved" | "rejected" | string;
  createdAt?: string;
  resolvedAt?: string | null;
  prUrl?: string | null;
  branch?: string | null;
  prNumber?: number | null;
  /** Memory server may send any of these for the contributor identity */
  contributorDisplayName?: string;
  contributorName?: string;
  contributorEmail?: string;
  proposerDisplayName?: string;
  submitterDisplayName?: string;
  externalUserDisplayName?: string;
  userDisplayName?: string;
  [key: string]: unknown;
}

function parseErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const msg =
      (typeof record.error === "string" && record.error) ||
      (typeof record.detail === "string" && record.detail) ||
      (typeof record.message === "string" && record.message);
    if (msg) {
      return msg.slice(0, 200);
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim().slice(0, 200);
  }
  return `Failed (${status})`;
}

export function contributorLabelForChangeRequest(
  req: CloudChangeRequest,
): string | null {
  const nameFields = [
    req.contributorDisplayName,
    req.contributorName,
    req.proposerDisplayName,
    req.submitterDisplayName,
    req.externalUserDisplayName,
    req.userDisplayName,
  ];
  for (const value of nameFields) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  if (typeof req.contributorEmail === "string" && req.contributorEmail.trim()) {
    return req.contributorEmail.trim();
  }
  const forkId =
    typeof req.installedAppId === "string" ? req.installedAppId.trim() : "";
  if (forkId.length >= 8) {
    return `Contributor (fork ${forkId.slice(0, 8)}…)`;
  }
  return null;
}

export async function fetchIncomingCloudChangeRequests(): Promise<
  CloudChangeRequest[]
> {
  const res = await fetch(`${GATEWAY}/api/cloud/apps/changes/incoming`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(parseErrorMessage(body, res.status));
  }
  const requests = (body as { requests?: CloudChangeRequest[] }).requests ?? [];
  return requests;
}

export async function resolveCloudChangeRequest(
  requestId: string,
  action: "approve" | "reject",
): Promise<void> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/apps/changes/${encodeURIComponent(requestId)}/${action}`,
    { method: "POST" },
  );
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(parseErrorMessage(body, res.status));
  }
}
