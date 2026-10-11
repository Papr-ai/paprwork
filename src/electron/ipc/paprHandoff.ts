/**
 * "Continue on your Mac" from Claude (PR 3).
 *
 *   Claude → papr_continue_on_mac → papr://auth/handoff?code=…   (10 min, single use)
 *   Mac    → POST {memory}/v1/cloud/handoff/redeem { code }       → desktop session + intent
 *
 * The code is the only thing in the link; the session is minted for this Mac on redeem.
 * Pure helpers live here so they're testable without Electron.
 */

export const HANDOFF_URL_PREFIX = "papr://auth/handoff";

export interface HandoffRedeemResult {
  userId: string;
  email?: string | null;
  displayName?: string | null;
  picture?: string | null;
  sessionToken: string;
  sessionExpiresAt: string;
  organizationId?: string | null;
  namespaceId?: string | null;
  workspaceId?: string | null;
  intent: { appNamespaceId?: string; appSlug?: string; view?: string; source?: string };
}

export function isHandoffUrl(url: string): boolean {
  return url.startsWith(HANDOFF_URL_PREFIX);
}

/** Code from papr://auth/handoff?code=… (URL-safe token, bounded length). */
export function parseHandoffCode(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "papr:" || u.hostname !== "auth" || u.pathname !== "/handoff") return null;
    const code = u.searchParams.get("code")?.trim() ?? "";
    return /^[A-Za-z0-9_-]{16,128}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

export function memoryBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.PAPR_MEMORY_SERVER_URL ??
    env.PAPR_AI_PROXY_BASE_URL?.replace(/\/v1\/ai\/?$/, "") ??
    "https://memory.papr.ai"
  ).replace(/\/$/, "");
}

export class HandoffRedeemError extends Error {}

export async function redeemHandoffCode(
  code: string,
  opts: { baseUrl?: string; device?: string; fetchImpl?: typeof fetch } = {},
): Promise<HandoffRedeemResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl ?? memoryBaseUrl()}/v1/cloud/handoff/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, device: opts.device ?? "papr-desktop" }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HandoffRedeemError("Couldn't reach Papr. Check your connection and open the link from Claude again.");
  }
  if (res.status === 400) {
    throw new HandoffRedeemError("That link has expired or was already used. Ask Claude for a new one.");
  }
  if (!res.ok) throw new HandoffRedeemError(`Couldn't sign you in from Claude (HTTP ${res.status}). Try again.`);
  const body = (await res.json()) as Partial<HandoffRedeemResult>;
  if (!body.sessionToken || !body.userId) throw new HandoffRedeemError("Papr returned an incomplete sign-in.");
  return {
    userId: body.userId,
    email: body.email ?? null,
    displayName: body.displayName ?? null,
    picture: body.picture ?? null,
    sessionToken: body.sessionToken,
    sessionExpiresAt: String(body.sessionExpiresAt ?? ""),
    organizationId: body.organizationId ?? null,
    namespaceId: body.namespaceId ?? null,
    workspaceId: body.workspaceId ?? null,
    intent: body.intent ?? {},
  };
}

/** What to show after landing: a new chat with a draft (never auto-sent). */
export function handoffLanding(
  intent: HandoffRedeemResult["intent"],
  appsBaseUrl = "https://apps.papr.ai",
): { title: string; message: string } {
  if (intent.appNamespaceId && intent.appSlug) {
    const link = `${appsBaseUrl}/${intent.appNamespaceId}/${intent.appSlug}`;
    const view = intent.view ? ` (${intent.view})` : "";
    return { title: "From Claude", message: `Let's keep working on ${intent.appSlug}${view} from Claude: ${link}` };
  }
  return { title: "From Claude", message: "" };
}

export type HandoffAccountDecision = "sign_in" | "same_user" | "different_user";

export function decideHandoffAccount(currentUserId: string | undefined, handoffUserId: string): HandoffAccountDecision {
  if (!currentUserId) return "sign_in";
  return currentUserId === handoffUserId ? "same_user" : "different_user";
}
