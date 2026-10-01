/**
 * Cross-instance hint that remote CDC triggers were prepared for a linked DB
 * at a given schema revision. Turso is still probed before skipping work.
 */

import { isGcsSharedCacheEnabled } from "./gcsSharedCache.js";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

let cachedToken: { token: string; expiresAt: number } | null = null;

function gcsBucket(): string | null {
  return process.env.CLOUD_APP_HOST_GCS_BUCKET || null;
}

async function getAccessToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.token;
  }
  try {
    const res = await fetch(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1_000,
    };
    return cachedToken.token;
  } catch {
    return null;
  }
}

function objectName(cacheKey: string, schemaRevision: string): string {
  return `cdc-ready/${encodeURIComponent(cacheKey)}/${encodeURIComponent(schemaRevision)}`;
}

export interface RemoteCdcReadyMarker {
  tableCount: number;
  recordedAtMs: number;
}

export async function readRemoteCdcReadyMarker(
  cacheKey: string,
  schemaRevision: string,
): Promise<RemoteCdcReadyMarker | null> {
  const bucket = gcsBucket();
  if (!bucket || !isGcsSharedCacheEnabled()) return null;
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const name = objectName(cacheKey, schemaRevision);
    const metaUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
    const dataRes = await fetch(`${metaUrl}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!dataRes.ok) return null;
    const parsed = JSON.parse(await dataRes.text()) as RemoteCdcReadyMarker;
    if (
      typeof parsed.tableCount !== "number" ||
      typeof parsed.recordedAtMs !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Fire-and-forget; never throws. */
export function writeRemoteCdcReadyMarker(
  cacheKey: string,
  schemaRevision: string,
  marker: RemoteCdcReadyMarker,
): void {
  const bucket = gcsBucket();
  if (!bucket || !isGcsSharedCacheEnabled()) return;

  void (async () => {
    const token = await getAccessToken();
    if (!token) return;
    try {
      const name = objectName(cacheKey, schemaRevision);
      const url =
        `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o` +
        `?uploadType=media&name=${encodeURIComponent(name)}`;
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(marker),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      /* best-effort */
    }
  })();
}
