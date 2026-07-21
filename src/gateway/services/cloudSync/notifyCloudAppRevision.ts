/**
 * Tell apps.papr.ai to invalidate repo caches and push a revision event to open tabs.
 * Called from desktop gateway after a successful git sync push.
 */

export interface NotifyCloudAppRevisionInput {
  namespaceId: string;
  slug: string;
}

export async function notifyCloudAppRevisionUpdated(
  input: NotifyCloudAppRevisionInput,
): Promise<void> {
  const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim();
  if (!hostKey) {
    return;
  }

  const host =
    process.env.PAPR_CLOUD_APPS_HOST?.replace(/\/$/, "") ?? "https://apps.papr.ai";

  try {
    const response = await fetch(`${host}/internal/app-revision-updated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cloud-App-Host-Key": hostKey,
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      console.warn(
        `[CloudSync] App revision notify failed (${response.status}) for ${input.namespaceId}/${input.slug}`,
      );
    }
  } catch (error) {
    console.warn(
      `[CloudSync] App revision notify error for ${input.namespaceId}/${input.slug}:`,
      (error as Error).message.slice(0, 120),
    );
  }
}

export function parsePublishedAppRoute(
  shareUrl: string | null | undefined,
): { namespaceId: string; slug: string } | null {
  if (!shareUrl) {
    return null;
  }

  let pathname = shareUrl;
  try {
    pathname = new URL(shareUrl).pathname;
  } catch {
    /* relative or bare path */
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const slug = parts[parts.length - 1];
  const namespaceId = parts[parts.length - 2];
  if (!namespaceId || !slug || namespaceId.includes("://")) {
    return null;
  }
  return { namespaceId, slug };
}
