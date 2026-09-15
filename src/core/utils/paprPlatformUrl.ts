/**
 * Resolve Papr dashboard base URLs for Electron IPC.
 *
 * Billing and team APIs normally share PAPR_PLATFORM_URL (e.g. ngrok → local
 * papr-dev-platform). Override team-only host with PAPR_TEAM_PLATFORM_URL when needed.
 */

export const PAPR_PRODUCTION_DASHBOARD_URL = "https://dashboard.papr.ai";
export const PAPR_PRODUCTION_PARSE_GRAPHQL_URL = "https://server.papr.ai/graphql";

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

export function getConfiguredPaprPlatformUrl(): string {
  return normalizeBaseUrl(process.env.PAPR_PLATFORM_URL || PAPR_PRODUCTION_DASHBOARD_URL);
}

export function getConfiguredParseGraphqlUrl(): string {
  return normalizeBaseUrl(
    process.env.PARSE_GRAPHQL_URL || PAPR_PRODUCTION_PARSE_GRAPHQL_URL,
  );
}

/**
 * Base URL for billing, usage metrics, and Stripe checkout (honors PAPR_PLATFORM_URL).
 */
export function getPaprBillingPlatformUrl(): string {
  return getConfiguredPaprPlatformUrl();
}

/**
 * Base URL for workspace team APIs (members, invites, roles, /people link).
 */
export function getPaprTeamPlatformUrl(): string {
  const override = process.env.PAPR_TEAM_PLATFORM_URL?.trim();
  if (override) {
    return normalizeBaseUrl(override);
  }
  return getConfiguredPaprPlatformUrl();
}
