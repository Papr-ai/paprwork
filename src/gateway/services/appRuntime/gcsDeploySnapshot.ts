/**
 * Immutable GCS deploy snapshots — written on Sync now (via revision notify warm).
 *
 * Unlike reactive repo-file L2 cache, deploy snapshots are proactive: after desktop
 * sync, the host prefetches key assets into `deploys/{namespace}/{slug}/{revision}/`
 * so cold instances and repeat visitors skip the GitHub fetch chain entirely.
 */

import { getGcsAccessToken, gcsBucketName as gcsBucket } from "./gcsSharedCache.js";

/** Static assets warmed into deploy snapshots after each sync. */
export const DEPLOY_SNAPSHOT_PATHS = [
  "index.html",
  "dist/app.js",
  "dist/app.css",
  "backend/manifest.json",
  "backend/bundle.json",
  "data-sources.json",
] as const;

export function deploySnapshotObjectPrefix(
  namespaceId: string,
  slug: string,
  revision: string,
): string {
  return `deploys/${encodeURIComponent(namespaceId)}/${encodeURIComponent(slug)}/${encodeURIComponent(revision)}/`;
}

function deploySnapshotObjectName(
  namespaceId: string,
  slug: string,
  revision: string,
  relativePath: string,
): string {
  return `${deploySnapshotObjectPrefix(namespaceId, slug, revision)}${encodeURIComponent(relativePath)}`;
}

export interface DeploySnapshotFile {
  content: string;
  contentType: string;
}

/** Read a file from an immutable deploy snapshot. Null on miss or error. */
export async function gcsDeploySnapshotGet(
  namespaceId: string,
  slug: string,
  revision: string,
  relativePath: string,
): Promise<DeploySnapshotFile | null> {
  const bucket = gcsBucket();
  if (!bucket) return null;
  const token = await getGcsAccessToken();
  if (!token) return null;

  try {
    const name = deploySnapshotObjectName(namespaceId, slug, revision, relativePath);
    const metaUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as {
      metadata?: { paprContentType?: string };
    };
    const dataRes = await fetch(`${metaUrl}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!dataRes.ok) return null;
    const content = await dataRes.text();
    return {
      content,
      contentType: meta.metadata?.paprContentType ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}

/** Write one file into the deploy snapshot. Fire-and-forget; never throws. */
export function gcsDeploySnapshotPut(
  namespaceId: string,
  slug: string,
  revision: string,
  relativePath: string,
  file: DeploySnapshotFile,
): void {
  const bucket = gcsBucket();
  if (!bucket) return;

  void (async () => {
    const token = await getGcsAccessToken();
    if (!token) return;
    try {
      const name = deploySnapshotObjectName(namespaceId, slug, revision, relativePath);
      const url =
        `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o` +
        `?uploadType=multipart&name=${encodeURIComponent(name)}`;
      const boundary = "papr-deploy-snapshot-boundary";
      const metadata = JSON.stringify({
        name,
        cacheControl: relativePath.startsWith("dist/")
          ? "public, max-age=31536000, immutable"
          : relativePath === "index.html"
            ? "no-cache, must-revalidate"
            : "public, max-age=3600",
        metadata: {
          paprContentType: file.contentType,
          paprDeployRevision: revision,
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
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      /* best-effort */
    }
  })();
}

/** Delete all deploy snapshot objects for a published app. Fire-and-forget. */
export function gcsDeploySnapshotDeleteByApp(
  namespaceId: string,
  slug: string,
): void {
  void gcsDeploySnapshotDeleteByPrefix(
    `deploys/${encodeURIComponent(namespaceId)}/${encodeURIComponent(slug)}/`,
  );
}

async function gcsDeploySnapshotDeleteByPrefix(objectPrefix: string): Promise<void> {
  const bucket = gcsBucket();
  if (!bucket) return;
  const token = await getGcsAccessToken();
  if (!token) return;

  try {
    let pageToken: string | undefined;
    do {
      const listUrl =
        `https://storage.googleapis.com/storage/v1/b/${bucket}/o` +
        `?prefix=${encodeURIComponent(objectPrefix)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const listRes = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!listRes.ok) return;
      const list = (await listRes.json()) as {
        items?: Array<{ name: string }>;
        nextPageToken?: string;
      };
      const names = (list.items ?? []).map((item) => item.name).filter(Boolean);
      if (names.length > 0) {
        await fetch(
          `https://storage.googleapis.com/storage/v1/b/${bucket}/o/batchDelete`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ objects: names.map((name) => ({ name })) }),
            signal: AbortSignal.timeout(30_000),
          },
        );
      }
      pageToken = list.nextPageToken;
    } while (pageToken);
  } catch {
    /* best-effort */
  }
}
