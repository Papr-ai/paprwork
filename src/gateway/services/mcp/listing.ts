/**
 * Two Papr connectors in Claude, one server.
 *
 *   personal  /mcp         Custom connector the user adds by URL. Every app they can open.
 *   listed    /mcp/listed  The connector in Anthropic's directory. Only apps Papr has
 *                          reviewed against the directory policy (PAPR_MCP_LISTED_APPS).
 *
 * Why: the directory reviews a connector as a whole and keeps re-reviewing it. Apps that
 * automate a third-party site with the user's login (LinkedIn Outreach) or whose main job
 * is AI video/image/audio (Scenario) fall outside that policy (Software Directory Policy
 * 3F, 4B). Showing them from the listed connector would put the whole listing at risk,
 * so they stay on the personal connector, and the listed one says how to get them.
 *
 * The allowlist is Papr's, not the publisher's: a publisher can't self-certify into the
 * directory. Card traffic (papr_api, card HTML) is checked against the same list without
 * loading the catalog, so the hot path stays one hop.
 */
import type { ClaudeApp } from "./catalog.js";

export type ConnectorMode = "personal" | "listed";

export const LISTED_SUFFIX = "/listed";

export interface ListingPolicy {
  /** "namespaceId/slug" keys Papr has reviewed for the directory listing. */
  reviewed: ReadonlySet<string>;
}

const KEY = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/;

export function loadListingPolicy(env: NodeJS.ProcessEnv = process.env): ListingPolicy {
  const reviewed = (env.PAPR_MCP_LISTED_APPS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => KEY.test(s));
  return { reviewed: new Set(reviewed) };
}

export const appKey = (a: { namespaceId: string; slug: string }): string => `${a.namespaceId}/${a.slug}`;

/** May this connector show (or tunnel for) this app? */
export function allowedIn(mode: ConnectorMode, policy: ListingPolicy, ref: { namespaceId: string; slug: string }): boolean {
  return mode === "personal" || policy.reviewed.has(appKey(ref));
}

/** Split the user's apps into what this connector shows and what only the personal one shows. */
export function splitForConnector(
  mode: ConnectorMode,
  policy: ListingPolicy,
  apps: ClaudeApp[],
): { shown: ClaudeApp[]; personalOnly: ClaudeApp[] } {
  if (mode === "personal") return { shown: apps, personalOnly: [] };
  const shown = apps.filter((a) => allowedIn(mode, policy, a));
  return { shown, personalOnly: apps.filter((a) => !shown.includes(a)) };
}

/** What Claude tells the user when an app lives only on the personal connector. */
export function personalConnectorNote(personalUrl: string, titles: string[]): string {
  if (!titles.length) return "";
  const names = titles.length <= 3 ? titles.join(", ") : `${titles.slice(0, 3).join(", ")} and ${titles.length - 3} more`;
  return (
    `${names} ${titles.length === 1 ? "works" : "work"} in Claude through your personal Papr connector, not this one. ` +
    `To add it: Claude → Settings → Connectors → Add custom connector → ${personalUrl}, then sign in with Papr. ` +
    "Apps like these (ones that act on another site with your login, or that make AI video or images) aren't part of Papr's directory listing."
  );
}
