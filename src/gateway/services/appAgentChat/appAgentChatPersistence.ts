/**
 * Durable app-agent chat persistence.
 *
 * Source-of-truth order (canonical → cache):
 *   1. apps/{appId}/agent-chat.json  — full config, synced with app folder
 *   2. data/apps.json registry entry — UI cache
 *   3. apps/{appId}/metadata.json    — published snapshot (public fields + job id)
 *
 * enable_app_agent_chat and AppService.setAppAgentChat write all three layers.
 */

import { promises as fs, readFileSync } from "fs";
import path from "path";
import type { AppAgentChatConfig } from "../../../core/types/appAgentChat.js";
import {
  parseCloudAppMetadataFile,
  type CloudAppMetadataFile,
} from "../../../core/utils/cloudAppMetadata.js";
import {
  readAgentChatSidecar,
  readAgentChatSidecarSync,
  writeAgentChatSidecar,
} from "../appAgentChatSidecar.js";

export function appAgentChatMetadataPath(paprDir: string, appId: string): string {
  return path.join(paprDir, "apps", appId, "metadata.json");
}

/** Convert published metadata fields into a registry/sidecar config (partial — no systemContext). */
export function agentChatConfigFromMetadataFile(
  metadata: CloudAppMetadataFile,
): AppAgentChatConfig | null {
  if (!metadata.agentChat?.enabled || !metadata.agentChat.subAgentId?.trim()) {
    return null;
  }
  return {
    enabled: true,
    subAgentId: metadata.agentChat.subAgentId.trim(),
    ...(metadata.agentChat.bubbleLabel
      ? { bubbleLabel: metadata.agentChat.bubbleLabel }
      : {}),
    ...(metadata.agentChat.welcomeMessage
      ? { welcomeMessage: metadata.agentChat.welcomeMessage }
      : {}),
    ...(metadata.agentChat.bubblePosition
      ? { bubblePosition: metadata.agentChat.bubblePosition }
      : {}),
    ...(metadata.agentChatJobId?.trim()
      ? { cloudJobId: metadata.agentChatJobId.trim() }
      : {}),
  };
}

export function readAgentChatFromMetadataSync(
  paprDir: string,
  appId: string,
): AppAgentChatConfig | null {
  try {
    const raw = readFileSync(appAgentChatMetadataPath(paprDir, appId), "utf8");
    const metadata = parseCloudAppMetadataFile(raw);
    return metadata ? agentChatConfigFromMetadataFile(metadata) : null;
  } catch {
    return null;
  }
}

export async function readAgentChatFromMetadata(
  paprDir: string,
  appId: string,
): Promise<AppAgentChatConfig | null> {
  try {
    const raw = await fs.readFile(appAgentChatMetadataPath(paprDir, appId), "utf8");
    const metadata = parseCloudAppMetadataFile(raw);
    return metadata ? agentChatConfigFromMetadataFile(metadata) : null;
  } catch {
    return null;
  }
}

/** Merge two configs — prefer richer (sidecar/registry) fields over metadata-only snapshot. */
export function mergeAppAgentChatConfigs(
  preferred: AppAgentChatConfig | null | undefined,
  fallback: AppAgentChatConfig | null | undefined,
): AppAgentChatConfig | null {
  if (preferred?.enabled && preferred.subAgentId?.trim()) {
    if (!fallback?.enabled) return preferred;
    return {
      ...fallback,
      ...preferred,
      enabled: true,
      subAgentId: preferred.subAgentId.trim(),
      allowedToolIds: preferred.allowedToolIds ?? fallback.allowedToolIds,
      systemContext: preferred.systemContext ?? fallback.systemContext,
      cloudJobId: preferred.cloudJobId ?? fallback.cloudJobId,
      bubbleLabel: preferred.bubbleLabel ?? fallback.bubbleLabel,
      welcomeMessage: preferred.welcomeMessage ?? fallback.welcomeMessage,
      bubblePosition: preferred.bubblePosition ?? fallback.bubblePosition,
      enabledAt: preferred.enabledAt ?? fallback.enabledAt,
    };
  }
  if (fallback?.enabled && fallback.subAgentId?.trim()) {
    return fallback;
  }
  return null;
}

/**
 * Resolve the best available agent chat config for an app.
 * Used on load, rebuild, getApp, and before registry/metadata writes.
 */
export async function resolveAppAgentChatConfig(
  paprDir: string,
  appId: string,
  registryConfig?: AppAgentChatConfig,
): Promise<AppAgentChatConfig | null> {
  const sidecar = await readAgentChatSidecar(paprDir, appId);
  const fromRegistry =
    registryConfig?.enabled && registryConfig.subAgentId?.trim()
      ? registryConfig
      : null;
  const fromMetadata = await readAgentChatFromMetadata(paprDir, appId);

  const merged = mergeAppAgentChatConfigs(
    mergeAppAgentChatConfigs(sidecar, fromRegistry),
    fromMetadata,
  );
  if (merged?.enabled) {
    return merged;
  }

  if (registryConfig && registryConfig.enabled === false) {
    return null;
  }

  return null;
}

export function resolveAppAgentChatConfigSync(
  paprDir: string,
  appId: string,
  registryConfig?: AppAgentChatConfig,
): AppAgentChatConfig | null {
  const sidecar = readAgentChatSidecarSync(paprDir, appId);
  const fromRegistry =
    registryConfig?.enabled && registryConfig.subAgentId?.trim()
      ? registryConfig
      : null;
  const fromMetadata = readAgentChatFromMetadataSync(paprDir, appId);

  const merged = mergeAppAgentChatConfigs(
    mergeAppAgentChatConfigs(sidecar, fromRegistry),
    fromMetadata,
  );
  if (merged?.enabled) {
    return merged;
  }

  if (registryConfig && registryConfig.enabled === false) {
    return null;
  }

  return null;
}

/**
 * Resolve config for metadata.json writes — never strip published agentChat
 * unless explicitly disabled (registry enabled:false and sidecar removed).
 */
export function resolveAppAgentChatForMetadataWrite(
  paprDir: string,
  appId: string,
  registryConfig?: AppAgentChatConfig,
): AppAgentChatConfig | null {
  const resolved = resolveAppAgentChatConfigSync(paprDir, appId, registryConfig);
  if (resolved?.enabled) {
    return resolved;
  }

  if (registryConfig && registryConfig.enabled === false) {
    return null;
  }

  return readAgentChatFromMetadataSync(paprDir, appId);
}

/** Write sidecar (canonical). Registry + metadata.json are updated by AppService. */
export async function persistAppAgentChatSidecar(
  paprDir: string,
  appId: string,
  agentChat: AppAgentChatConfig | undefined,
): Promise<void> {
  await writeAgentChatSidecar(paprDir, appId, agentChat);
}

export interface HydrateAgentChatResult {
  agentChat: AppAgentChatConfig | null;
  /** Sidecar was written because config existed only in registry/metadata. */
  sidecarBackfilled: boolean;
  /** Registry entry should be updated with resolved config. */
  registryNeedsUpdate: boolean;
}

/**
 * Hydrate agent chat for one app: resolve from disk, backfill sidecar if missing.
 */
export async function hydrateAppAgentChatFromDisk(
  paprDir: string,
  appId: string,
  registryConfig?: AppAgentChatConfig,
): Promise<HydrateAgentChatResult> {
  const resolved = await resolveAppAgentChatConfig(paprDir, appId, registryConfig);
  if (!resolved?.enabled) {
    return {
      agentChat: null,
      sidecarBackfilled: false,
      registryNeedsUpdate: false,
    };
  }

  const sidecar = await readAgentChatSidecar(paprDir, appId);
  let sidecarBackfilled = false;
  if (!sidecar?.enabled) {
    await writeAgentChatSidecar(paprDir, appId, resolved);
    sidecarBackfilled = true;
  }

  const registryNeedsUpdate =
    !registryConfig?.enabled ||
    registryConfig.subAgentId !== resolved.subAgentId ||
    registryConfig.cloudJobId !== resolved.cloudJobId;

  return {
    agentChat: resolved,
    sidecarBackfilled,
    registryNeedsUpdate,
  };
}
