import fs from "fs";
import path from "path";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";

const CACHE_TTL_MS = 30_000;

let cachedUserId: string | undefined;
let cachedAt = 0;

/**
 * Parse _User.objectId of the locally-authenticated Papr user.
 *
 * Pass as `user_id` on Papr Memory API calls. Paprwork users ARE real Papr
 * accounts, so sending this as `external_user_id` makes the memory server mint
 * an anonymous shadow DeveloperUser — splitting one human into several
 * identities and breaking feedback authorization.
 *
 * This is the ONLY source of user identity for memory calls. It is read from
 * local login state and is never caller-supplied, so a namespace API key cannot
 * be used to write memories owned by an arbitrary Papr account.
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
 *
 * Always resolves the acting user locally — callers cannot inject an identity.
 * Returns `{}` when not logged in, so the server falls back to the API key
 * owner rather than writing memories under an unauthenticated id.
 */
export function paprUserScope(): { user_id: string } | Record<string, never> {
  const userId = getPaprUserId();
  return userId ? { user_id: userId } : {};
}

/**
 * Guard for call sites that accept a user id from an argument or request body.
 *
 * The Papr API key is scoped to org + namespace, not to a person, so a
 * caller-supplied id would let any holder of the key write memories owned by an
 * arbitrary Papr account. We accept the value only when it matches the locally
 * authenticated user; otherwise we fall back to the local identity.
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
