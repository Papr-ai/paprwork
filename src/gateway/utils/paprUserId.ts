import fs from "fs";
import path from "path";
import { spreadPaprMemoryUserIdentity } from "../../core/utils/paprMemoryUserIdentity.js";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";

const CACHE_TTL_MS = 30_000;

let cachedUserId: string | undefined;
let cachedAt = 0;

/**
 * Parse _User.objectId of the locally-authenticated Papr user.
 *
 * Pass as both `user_id` and `external_user_id` on Papr Memory API calls.
 * The memory server prefers `user_id` for end_user_id (no shadow DeveloperUser)
 * while keeping `external_user_id` for backward compatibility.
 *
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
    const settingsPath = path.join(getPaprDataDir(), "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as {
      profile?: { paprUserId?: string };
      paprProfile?: { userId?: string };
    };
    cachedUserId =
      settings.profile?.paprUserId?.trim() ??
      settings.paprProfile?.userId?.trim() ??
      "";
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

/**
 * Spread into Papr SDK request bodies to scope a call to the logged-in user.
 * Sends both user_id and external_user_id (same Parse objectId).
 */
export function paprUserScope(): ReturnType<typeof spreadPaprMemoryUserIdentity> {
  return spreadPaprMemoryUserIdentity(getPaprUserId());
}

/**
 * Accept a caller-supplied id only when it matches the locally authenticated user.
 */
export function resolveTrustedPaprUserId(
  candidate?: string | null,
): string | undefined {
  const localUserId = getPaprUserId();
  const requested = candidate?.trim();

  if (!requested || !localUserId || requested === localUserId) {
    return localUserId;
  }

  console.warn(
    `[paprUserId] Ignoring caller-supplied user_id "${requested}" — ` +
      `does not match authenticated user. Using local identity instead.`,
  );
  return localUserId;
}

/** Caller identity for GET /api/access and verified job params on desktop. */
export function getPaprCallerIdentity(): { userId?: string; email?: string } {
  const userId = getPaprUserId();
  try {
    const settingsPath = path.join(getPaprDataDir(), "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as {
      paprProfile?: { userId?: string; email?: string };
      profile?: { paprUserId?: string };
    };
    const email = settings.paprProfile?.email?.trim() || undefined;
    const profileUserId = settings.paprProfile?.userId?.trim();
    return {
      userId: userId ?? profileUserId,
      email,
    };
  } catch {
    return userId ? { userId } : {};
  }
}
