/**
 * Persistent on-disk agent chat config (survives apps.json index rebuilds).
 */

import { promises as fs, readFileSync } from "fs";
import path from "path";
import type { AppAgentChatConfig } from "../../core/types/appAgentChat.js";

export const APP_AGENT_CHAT_SIDECAR_FILENAME = "agent-chat.json";

export function agentChatSidecarPath(paprDir: string, appId: string): string {
  return path.join(paprDir, "apps", appId, APP_AGENT_CHAT_SIDECAR_FILENAME);
}

export function readAgentChatSidecarSync(
  paprDir: string,
  appId: string,
): AppAgentChatConfig | null {
  try {
    const raw = readFileSync(agentChatSidecarPath(paprDir, appId), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppAgentChatConfig>;
    if (!parsed.enabled || !parsed.subAgentId?.trim()) {
      return null;
    }
    return parsed as AppAgentChatConfig;
  } catch {
    return null;
  }
}

export async function readAgentChatSidecar(
  paprDir: string,
  appId: string,
): Promise<AppAgentChatConfig | null> {
  try {
    const raw = await fs.readFile(agentChatSidecarPath(paprDir, appId), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppAgentChatConfig>;
    if (!parsed.enabled || !parsed.subAgentId?.trim()) {
      return null;
    }
    return parsed as AppAgentChatConfig;
  } catch {
    return null;
  }
}

export async function writeAgentChatSidecar(
  paprDir: string,
  appId: string,
  agentChat: AppAgentChatConfig | undefined,
): Promise<void> {
  const sidecarPath = agentChatSidecarPath(paprDir, appId);
  if (!agentChat?.enabled) {
    try {
      await fs.unlink(sidecarPath);
    } catch {
      /* absent is fine */
    }
    return;
  }

  await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
  const tmpPath = `${sidecarPath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(agentChat, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, sidecarPath);
}
