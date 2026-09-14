import fs from "fs";
import path from "path";
import { readActiveAppWorkspaceScope } from "../../core/utils/appWorkspaceScope.js";
import { spreadPaprMemoryUserIdentity } from "../../core/utils/paprMemoryUserIdentity.js";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";

const CACHE_TTL_MS = 30_000;

let cachedUserId: string | undefined;
let cachedAt = 0;

/**
 * Whether we know who the local Papr user is — and if not, whether that is an
 * answer or merely an absence of one.
 *
 * `absent` and `unresolved` both yield no id, but callers must treat them
 * differently. "Nobody is signed in" licenses filtering another user's content
 * out of view; "I could not tell, yet" licenses nothing, because acting on it
 * hides the signed-in user's own content and reports the result as fact.
 */
export type PaprUserIdentityState = "known" | "absent" | "unresolved";

export interface PaprUserIdentity {
  userId?: string;
  state: PaprUserIdentityState;
}

/**
 * A namespaced workspace is only ever created for a signed-in Papr user, so
 * inside one, "I cannot name the user" is a race and never a verdict. That is
 * what separates the boot window — where the main process has not yet written
 * the profile into settings.json — from an open-source install that genuinely
 * has no Papr account.
 */
function workspaceImpliesSignedInUser(): boolean {
  try {
    return readActiveAppWorkspaceScope() !== null;
  } catch {
    return false;
  }
}

/**
 * Resolve the local Papr user, reporting *why* when there is no id.
 *
 * Only a positive answer is cached. Caching a miss saves one small synchronous
 * read and costs up to CACHE_TTL_MS of confidently wrong answers — and the miss
 * is exactly the transient case, since it is what the boot window produces
 * before the profile lands in settings.json.
 */
export function resolvePaprUserIdentity(): PaprUserIdentity {
  const envId = process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID?.trim();
  if (envId) {
    return { userId: envId, state: "known" };
  }

  const now = Date.now();
  if (cachedUserId && now - cachedAt < CACHE_TTL_MS) {
    return { userId: cachedUserId, state: "known" };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(path.join(getPaprDataDir(), "settings.json"), "utf-8");
  } catch {
    // No readable settings at all. In a namespaced workspace that file is
    // expected, so its absence is a workspace still being assembled.
    return { state: workspaceImpliesSignedInUser() ? "unresolved" : "absent" };
  }

  let found: string | undefined;
  try {
    const settings = JSON.parse(raw) as {
      profile?: { paprUserId?: string };
      paprProfile?: { userId?: string };
    };
    found =
      settings.profile?.paprUserId?.trim() ||
      settings.paprProfile?.userId?.trim() ||
      undefined;
  } catch {
    // Malformed or mid-write. Nothing was learned either way.
    return { state: workspaceImpliesSignedInUser() ? "unresolved" : "absent" };
  }

  if (found) {
    cachedUserId = found;
    cachedAt = now;
    return { userId: found, state: "known" };
  }

  return { state: workspaceImpliesSignedInUser() ? "unresolved" : "absent" };
}

/**
 * Parse _User.objectId of the locally-authenticated Papr user.
 *
 * Pass as both `user_id` and `external_user_id` on Papr Memory API calls.
 * The memory server prefers `user_id` for end_user_id (no shadow DeveloperUser)
 * while keeping `external_user_id` for backward compatibility.
 *
 * Prefers gateway env (set at spawn); falls back to settings.json after login.
 *
 * Returns undefined for both `absent` and `unresolved`. Callers that would
 * *hide* something on the strength of that must use `resolvePaprUserIdentity`
 * instead and distinguish the two.
 */
export function getPaprUserId(): string | undefined {
  return resolvePaprUserIdentity().userId;
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
