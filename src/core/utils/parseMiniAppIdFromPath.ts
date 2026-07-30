/**
 * Browser-safe mini-app id extraction from Papr paths (no Node built-ins).
 * Shared by gateway tools and renderer UI.
 */

const APP_ID_UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function matchAppsSegment(normalized: string): string | undefined {
  const match =
    normalized.match(
      new RegExp(`/apps/(${APP_ID_UUID.source})`, "i"),
    ) ?? normalized.match(/\/apps\/([^/]+)/i);
  return match?.[1];
}

/** Extract mini-app UUID from a path under Papr (legacy or org/namespace layout). */
export function parseMiniAppIdFromAgentPath(rawPath: string): string | undefined {
  const normalized = rawPath.replace(/^~(?=$|[/\\])/, "").replace(/\\/g, "/");

  // Agent shorthand: $PAPR_HOME/apps/{appId}/… (no literal "Papr" in the string)
  const paprHomeMatch = normalized.match(
    /(?:\$PAPR_HOME|PAPR_HOME)\/apps\/([^/]+)/i,
  );
  if (paprHomeMatch?.[1]) {
    return paprHomeMatch[1];
  }

  // Absolute/tilde paths: ~/Papr/…/apps/{appId}/… or /Users/…/Papr/orgs/…/apps/{appId}/…
  if (/\bPapr\b/i.test(normalized) || /\/apps\//i.test(normalized)) {
    return matchAppsSegment(normalized);
  }

  return undefined;
}
