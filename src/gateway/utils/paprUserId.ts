import fs from "fs";
import path from "path";
import os from "os";

const SETTINGS_PATH = path.join(os.homedir(), "Papr", "data", "settings.json");
const CACHE_TTL_MS = 30_000;

let cachedUserId: string | undefined;
let cachedAt = 0;

/**
 * Parse _User.objectId for PAPR memory/message writes (user_id field).
 * Prefers gateway env (set at spawn); falls back to settings.json after login.
 */
export function getPaprUserId(): string | undefined {
  const envId = process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID?.trim();
  if (envId) {
    return envId;
  }

  const now = Date.now();
  if (cachedUserId !== undefined && now - cachedAt < CACHE_TTL_MS) {
    return cachedUserId || undefined;
  }

  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw) as { profile?: { paprUserId?: string } };
    cachedUserId = settings.profile?.paprUserId?.trim() ?? "";
    cachedAt = now;
    return cachedUserId || undefined;
  } catch {
    return undefined;
  }
}

/** Clear cache after login sync so gateway picks up new userId immediately. */
export function invalidatePaprUserIdCache(): void {
  cachedUserId = undefined;
  cachedAt = 0;
}
