/**
 * Shared GCS cache layer for the Cloud App Host repo-file cache.
 *
 * Problem: the in-process cache is per Cloud Run instance (max 20). Each new
 * instance pays the full memory-server → GitHub fetch chain to warm up.
 * This layer shares warmed content across instances via a GCS bucket.
 *
 * Design:
 * - Dependency-free: uses the GCS JSON/upload REST API with an access token
 *   from the Cloud Run metadata server (works with the default service
 *   account — no key files, no @google-cloud/storage).
 * - Opt-in: only active when CLOUD_APP_HOST_GCS_BUCKET is set. Local desktop
 *   gateways never touch it.
 * - Best-effort: any GCS failure falls through to the origin fetch. Writes
 *   are fire-and-forget.
 * - Objects carry a `paprFreshUntil` metadata timestamp so readers can apply
 *   the same fresh/stale semantics as the in-process cache.
 */

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

let cachedToken: { token: string; expiresAt: number } | null = null;

function gcsBucket(): string | null {
  return process.env.CLOUD_APP_HOST_GCS_BUCKET || null;
}

export function isGcsSharedCacheEnabled(): boolean {
  return gcsBucket() !== null;
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
    return null; // Not on GCP (local dev) or metadata server unreachable
  }
}

function objectName(cacheKey: string): string {
  // Cache keys contain slashes/colons; encode into a flat, safe object name.
  return `repo-files/${encodeURIComponent(cacheKey)}`;
}

export interface GcsCachedFile {
  content: string;
  contentType: string;
  /** Epoch ms after which callers should revalidate against origin. */
  freshUntil: number;
}

/** Read a cached repo file from the shared bucket. Null on miss or any error. */
export async function gcsCacheGet(cacheKey: string): Promise<GcsCachedFile | null> {
  const bucket = gcsBucket();
  if (!bucket) return null;
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const name = objectName(cacheKey);
    const metaUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as {
      metadata?: { paprFreshUntil?: string; paprContentType?: string };
    };
    const freshUntil = Number(meta.metadata?.paprFreshUntil ?? 0);

    const dataRes = await fetch(`${metaUrl}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!dataRes.ok) return null;
    const content = await dataRes.text();
    return {
      content,
      contentType: meta.metadata?.paprContentType ?? "application/octet-stream",
      freshUntil,
    };
  } catch {
    return null;
  }
}

/** Write a repo file to the shared bucket. Fire-and-forget; never throws. */
export function gcsCachePut(
  cacheKey: string,
  file: { content: string; contentType: string },
  freshUntil: number,
): void {
  const bucket = gcsBucket();
  if (!bucket) return;

  void (async () => {
    const token = await getAccessToken();
    if (!token) return;
    try {
      const name = objectName(cacheKey);
      const url =
        `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o` +
        `?uploadType=multipart&name=${encodeURIComponent(name)}`;
      const boundary = "papr-gcs-cache-boundary";
      const metadata = JSON.stringify({
        name,
        metadata: {
          paprFreshUntil: String(freshUntil),
          paprContentType: file.contentType,
        },
      });
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${metadata}\r\n--${boundary}\r\nContent-Type: ${file.contentType}\r\n\r\n` +
        `${file.content}\r\n--${boundary}--`;
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Best-effort — in-process cache still works without GCS.
    }
  })();
}
