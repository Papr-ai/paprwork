/**
 * metadata.json in each synced mini-app folder (title, description, icon for cloud previews).
 */

export interface CloudAppMetadataFile {
  appId: string;
  title: string;
  description: string;
  icon?: string;
  updatedAt: string;
}

export const DEFAULT_CLOUD_APP_DESCRIPTION =
  "An interactive mini-app built with Papr Work.";

export function buildDefaultCloudAppDescription(title: string): string {
  return `${title} — ${DEFAULT_CLOUD_APP_DESCRIPTION}`;
}

export function humanizeCloudAppSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function parseCloudAppMetadataFile(raw: string): CloudAppMetadataFile | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CloudAppMetadataFile>;
    if (!parsed.appId || !parsed.title) {
      return null;
    }
    return {
      appId: parsed.appId,
      title: parsed.title.trim(),
      description:
        parsed.description?.trim() ||
        buildDefaultCloudAppDescription(parsed.title.trim()),
      ...(parsed.icon ? { icon: parsed.icon } : {}),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function serializeCloudAppMetadataFile(metadata: CloudAppMetadataFile): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}
