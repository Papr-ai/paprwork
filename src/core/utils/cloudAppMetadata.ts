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
  /** Papr user id of the app owner (My Apps scope). */
  ownerUserId?: string;
  /** Workspace this app belongs to (My Apps scope). */
  organizationId?: string;
  namespaceId?: string;
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
      ...(parsed.ownerUserId ? { ownerUserId: parsed.ownerUserId.trim() } : {}),
      ...(parsed.organizationId ? { organizationId: parsed.organizationId.trim() } : {}),
      ...(parsed.namespaceId ? { namespaceId: parsed.namespaceId.trim() } : {}),
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
