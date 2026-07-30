/**
 * Write metadata.json into mini-app folders for cloud link previews.
 */

import { promises as fs, readFileSync } from "fs";
import path from "path";
import {
  buildDefaultCloudAppDescription,
  serializeCloudAppMetadataFile,
  type CloudAppMetadataFile,
} from "../../core/utils/cloudAppMetadata.js";
import {
  toPublicAppAgentChatConfig,
  type AppAgentChatConfig,
} from "../../core/types/appAgentChat.js";

export interface CloudAppRegistryEntry {
  id: string;
  title?: string;
  description?: string;
  icon?: string;
  ownerUserId?: string;
  organizationId?: string;
  namespaceId?: string;
  agentChat?: AppAgentChatConfig;
}

export function loadCloudAppRegistryEntries(
  paprDir: string,
): CloudAppRegistryEntry[] {
  try {
    const raw = readFileSync(path.join(paprDir, "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw) as
      | CloudAppRegistryEntry[]
      | Record<string, CloudAppRegistryEntry>;
    return Array.isArray(parsed) ? parsed : Object.values(parsed);
  } catch {
    return [];
  }
}

export function resolveCloudAppRegistryEntry(
  paprDir: string,
  appId: string,
): CloudAppRegistryEntry | null {
  return (
    loadCloudAppRegistryEntries(paprDir).find((entry) => entry.id === appId) ??
    null
  );
}

export async function writeCloudAppMetadataFile(
  paprDir: string,
  appId: string,
): Promise<void> {
  const entry = resolveCloudAppRegistryEntry(paprDir, appId);
  if (!entry) {
    return;
  }

  const title = entry.title?.trim() || appId.slice(0, 8);
  const metadata: CloudAppMetadataFile = {
    appId,
    title,
    description:
      entry.description?.trim() || buildDefaultCloudAppDescription(title),
    updatedAt: new Date().toISOString(),
    ...(entry.ownerUserId ? { ownerUserId: entry.ownerUserId } : {}),
    ...(entry.organizationId ? { organizationId: entry.organizationId } : {}),
    ...(entry.namespaceId ? { namespaceId: entry.namespaceId } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
    ...(entry.agentChat?.enabled
      ? {
          agentChat: toPublicAppAgentChatConfig(entry.agentChat),
          ...(entry.agentChat.cloudJobId
            ? { agentChatJobId: entry.agentChat.cloudJobId }
            : {}),
        }
      : {}),
  };

  const appDir = path.join(paprDir, "apps", appId);
  await fs.mkdir(appDir, { recursive: true });
  const metadataPath = path.join(appDir, "metadata.json");
  const tmpPath = `${metadataPath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, serializeCloudAppMetadataFile(metadata), "utf8");
  await fs.rename(tmpPath, metadataPath);
}
