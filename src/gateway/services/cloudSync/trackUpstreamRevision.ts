/**
 * Published-app revision probe for track-mode pull-on-publish.
 */

export function publishedAppRevisionJsonUrl(
  namespaceId: string,
  slug: string,
): string {
  const host =
    process.env.PAPR_CLOUD_APPS_HOST?.replace(/\/$/, "") ??
    "https://apps.papr.ai";
  return `${host}/${encodeURIComponent(namespaceId)}/${encodeURIComponent(slug)}/__papr__/app-revision.json`;
}

export async function fetchPublishedAppRevision(
  namespaceId: string,
  slug: string,
): Promise<string | null> {
  const url = publishedAppRevisionJsonUrl(namespaceId, slug);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { revision?: string };
    const revision = body.revision?.trim();
    return revision && revision.length > 0 ? revision : null;
  } catch {
    return null;
  }
}
