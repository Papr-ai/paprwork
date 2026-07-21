/**
 * Extract mini-app id from an edit_file path (~/Papr/apps/{appId}/...).
 */
export function parseAppIdFromEditFilePath(rawPath: unknown): string | undefined {
  if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
  const normalized = rawPath.replace(/^~(?=$|[/\\])/, "").replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)Papr\/apps\/([^/]+)/i);
  return match?.[1];
}
