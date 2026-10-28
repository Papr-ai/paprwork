/**
 * "Continue on your Mac": a one-time papr:// link minted by memory for the signed-in caller.
 *
 *   POST {memory}/v1/cloud/handoff/codes  X-Session-Token: <caller's MCP session>
 *     → { code, url: "papr://auth/handoff?code=…", expiresAt }   (10 min, single use)
 *
 * The Mac redeems the code for its own session, so nothing long-lived ever passes through
 * Claude. Also the path for actions marked runsOn: "mac" when the publisher's Mac is the
 * user's own.
 */
import type { McpCaller } from "./auth.js";
import { openPageUrl } from "./openPage.js";

export interface HandoffIntent {
  appNamespaceId?: string;
  appSlug?: string;
  view?: string;
}

export interface HandoffLink {
  /** What Claude opens: an https page that launches the desktop app (Claude blocks papr://). */
  url: string;
  /** The raw one-time papr:// link. */
  paprUrl?: string;
  expiresAt: string;
}

export type CreateHandoff = (caller: McpCaller, intent: HandoffIntent) => Promise<HandoffLink>;

export class HandoffError extends Error {}

/**
 * `appsBaseUrl` builds the web fallback; `pageBaseUrl` is where /open is served (the MCP host's
 * own origin). Without `pageBaseUrl` the raw papr:// link is returned (desktop gateway).
 */
export function memoryHandoff(baseUrl: string, fetchImpl: typeof fetch = fetch, appsBaseUrl?: string, pageBaseUrl?: string): CreateHandoff {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/cloud/handoff/codes`;
  return async (caller, intent) => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "X-Session-Token": caller.sessionToken },
        body: JSON.stringify({ ...intent, source: "claude" }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HandoffError("Papr is unreachable right now. Try again in a moment.");
    }
    if (res.status === 429) throw new HandoffError("Too many Mac links in a short time. Wait a minute and try again.");
    if (!res.ok) throw new HandoffError(`Couldn't create a Mac link (HTTP ${res.status}).`);
    const body = (await res.json()) as { url?: string; expiresAt?: string };
    if (!body.url?.startsWith("papr://")) throw new HandoffError("Papr returned an invalid Mac link.");
    const expiresAt = String(body.expiresAt ?? "");
    if (!pageBaseUrl) return { url: body.url, expiresAt };
    const web = appsBaseUrl && intent.appNamespaceId && intent.appSlug ? `${appsBaseUrl.replace(/\/$/, "")}/${intent.appNamespaceId}/${intent.appSlug}` : undefined;
    return { url: openPageUrl(pageBaseUrl, body.url, web), paprUrl: body.url, expiresAt };
  };
}
