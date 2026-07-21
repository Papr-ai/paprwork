/**
 * metadata.json in each synced mini-app folder (title, description, icon for cloud previews).
 */

import type { PublicAppAgentChatConfig } from "../types/appAgentChat.js";

export interface CloudAppMetadataFile {
  appId: string;
  title: string;
  description: string;
  icon?: string;
  updatedAt: string;
  /** Embedded sub-agent chat (public fields only). */
  agentChat?: PublicAppAgentChatConfig;
  /** Hidden subagent job for cloud app-agent SSE turns. */
  agentChatJobId?: string;
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
      ...(parsed.agentChat ? { agentChat: parsed.agentChat } : {}),
      ...(parsed.agentChatJobId ? { agentChatJobId: parsed.agentChatJobId } : {}),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function serializeCloudAppMetadataFile(metadata: CloudAppMetadataFile): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}
