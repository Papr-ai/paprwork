/**
 * Gateway-readable Papr profile fields synced from Electron login.
 */

import fs from "fs";
import path from "path";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";

const CACHE_TTL_MS = 30_000;

export interface GatewayPaprProfile {
  paprUserId?: string;
  paprWorkspaceId?: string;
  paprWorkspaceName?: string;
  email?: string;
  name?: string;
}

let cachedProfile: GatewayPaprProfile | undefined;
let cachedAt = 0;

function readGatewaySettingsProfile(): GatewayPaprProfile {
  try {
    const settingsPath = path.join(getPaprDataDir(), "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as {
      profile?: {
        paprUserId?: string;
        paprWorkspaceId?: string;
        paprWorkspaceName?: string;
        email?: string;
        name?: string;
      };
    };
    const profile = settings.profile ?? {};
    return {
      paprUserId: profile.paprUserId?.trim() || undefined,
      paprWorkspaceId: profile.paprWorkspaceId?.trim() || undefined,
      paprWorkspaceName: profile.paprWorkspaceName?.trim() || undefined,
      email: profile.email?.trim() || undefined,
      name: profile.name?.trim() || undefined,
    };
  } catch {
    return {};
  }
}

export function getGatewayPaprProfile(): GatewayPaprProfile {
  const now = Date.now();
  if (cachedProfile !== undefined && now - cachedAt < CACHE_TTL_MS) {
    return cachedProfile;
  }
  cachedProfile = readGatewaySettingsProfile();
  cachedAt = now;
  return cachedProfile;
}

export function getPaprWorkspaceId(): string | undefined {
  const envId = process.env.PAPR_WORKSPACE_ID?.trim();
  if (envId) {
    return envId;
  }
  return getGatewayPaprProfile().paprWorkspaceId;
}

export function invalidateGatewayPaprProfileCache(): void {
  cachedProfile = undefined;
  cachedAt = 0;
}
