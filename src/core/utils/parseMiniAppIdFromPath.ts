/**
 * Browser-safe mini-app id extraction from Papr paths (no Node built-ins).
 * Shared by gateway tools and renderer UI.
 */

const APP_ID_UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function matchAppsSegment(normalized: string): string | undefined {
  // Mini-app storage is always the lowercase segment `/apps/`, not UI folders
  // like `ui/components/Apps/` in the paprwork-v2 repo.
  const idx = normalized.indexOf("/apps/");
  if (idx === -1) {
    return undefined;
  }
  const segment = normalized.slice(idx + "/apps/".length).split("/")[0];
  if (!segment || segment.includes(".")) {
    return undefined;
  }
  if (APP_ID_UUID.test(segment)) {
    return segment;
  }
  if (/^[a-z0-9-]+$/i.test(segment)) {
    return segment;
  }
  return undefined;
}

/** Extract mini-app UUID from a path under Papr (legacy or org/namespace layout). */
export function parseMiniAppIdFromAgentPath(rawPath: string): string | undefined {
  const normalized = rawPath.replace(/^~(?=$|[/\\])/, "").replace(/\\/g, "/");

  // Agent shorthand: $PAPR_HOME/apps/{appId}/… (no literal "Papr" in the string)
  const paprHomeMatch = normalized.match(
    /(?:\$PAPR_HOME|PAPR_HOME)\/apps\/([^/]+)/,
  );
  if (paprHomeMatch?.[1] && !paprHomeMatch[1].includes(".")) {
    return paprHomeMatch[1];
  }

  // Absolute/tilde paths: ~/Papr/…/apps/{appId}/… or /Users/…/Papr/orgs/…/apps/{appId}/…
  if (/\bPapr\b/i.test(normalized) || normalized.includes("/apps/")) {
    return matchAppsSegment(normalized);
  }

  return undefined;
}
