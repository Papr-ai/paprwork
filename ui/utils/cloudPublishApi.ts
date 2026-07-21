/**
 * Gateway API helpers for cloud mini-app publish / sharing.
 */

import type { CloudExternalLink, CloudLoginAccess } from "./cloudShareLink";
import type { CodeAccess } from "../../src/core/utils/shareAudienceModel";
import type { CloudCompatibilityReport } from "../../src/core/types/cloudAppCompatibility";

const GATEWAY =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export interface CloudPublishPrefs {
  autoPublish?: boolean;
  accessMode?: string;
  loginAccess?: CloudLoginAccess;
  externalLink?: CloudExternalLink;
  codeAccess?: CodeAccess;
}

export interface CloudPublishState {
  appId: string;
  enabled: boolean;
  accessMode: string;
  loginAccess?: CloudLoginAccess;
  externalLink?: CloudExternalLink;
  shareUrl: string | null;
  shareToken?: string | null;
  shareLink?: string | null;
  slug: string | null;
  publishedAt: string | null;
  lastError?: string | null;
  prefs?: CloudPublishPrefs;
  compatibility?: CloudCompatibilityReport;
}

export class CloudPublishBlockedError extends Error {
  compatibility: CloudCompatibilityReport;

  constructor(message: string, compatibility: CloudCompatibilityReport) {
    super(message);
    this.name = "CloudPublishBlockedError";
    this.compatibility = compatibility;
  }
}

export async function fetchCloudPublishState(
  appId: string,
): Promise<CloudPublishState | null> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/publish/${encodeURIComponent(appId)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? `Failed to load publish state (${res.status})`);
  }
  return (await res.json()) as CloudPublishState;
}

export async function fetchCloudCompatibility(
  appId: string,
): Promise<CloudCompatibilityReport> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/publish/${encodeURIComponent(appId)}/compatibility`,
  );
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? `Compatibility scan failed (${res.status})`);
  }
  return (await res.json()) as CloudCompatibilityReport;
}

export async function publishCloudApp(
  appId: string,
  input: {
    loginAccess?: CloudLoginAccess;
    externalLink?: CloudExternalLink;
    codeAccess?: CodeAccess;
    autoPublish?: boolean;
    acknowledgeDesktopOnly?: boolean;
  },
): Promise<CloudPublishState> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/publish/${encodeURIComponent(appId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        autoPublish: input.autoPublish ?? true,
      }),
    },
  );
  const body = (await res.json()) as CloudPublishState & {
    error?: string;
    compatibility?: CloudCompatibilityReport;
  };
  if (res.status === 409 && body.compatibility) {
    throw new CloudPublishBlockedError(
      body.error ?? "Desktop-only app requires confirmation",
      body.compatibility,
    );
  }
  if (!res.ok) {
    throw new Error(body.error ?? `Publish failed (${res.status})`);
  }
  return body;
}

export async function patchCloudPublishPrefs(
  appId: string,
  input: Partial<CloudPublishPrefs>,
): Promise<CloudPublishPrefs> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/publish/${encodeURIComponent(appId)}/prefs`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body = (await res.json()) as { prefs?: CloudPublishPrefs; error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Prefs update failed (${res.status})`);
  }
  return body.prefs ?? {};
}

export async function unpublishCloudApp(appId: string): Promise<void> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/publish/${encodeURIComponent(appId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? `Unpublish failed (${res.status})`);
  }
}
