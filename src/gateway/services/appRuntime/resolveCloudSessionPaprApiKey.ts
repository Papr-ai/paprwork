/**
 * Resolve a Papr org API key from a web session cookie for Cloud App Host runtime calls.
 * Used server-side on apps.papr.ai when the browser only has papr_session (no X-API-Key).
 * Desktop cloud-preview proxy does not call this — it forwards session + external_user_id only.
 */

import { GET_NAMESPACE_API_KEYS } from "../../../core/papr/paprLoginGraphql.js";
import { parsePaprApiKeyScope } from "../../../core/utils/paprApiKey.js";
import { readActiveWorkspacePointer } from "../../../core/utils/paprWorkspace.js";
import type { AppRuntimeRouteAuth } from "./types.js";

const PARSE_GRAPHQL_URL =
  process.env.PARSE_GRAPHQL_URL ?? "https://server.papr.ai/graphql";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID ?? "671e705a-f735-4ec0-8474-15899a475440";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface ApiKeyCacheEntry {
  apiKey: string;
  expiresAt: number;
}

const apiKeyCache = new Map<string, ApiKeyCacheEntry>();

interface ParseGraphQLResponse {
  data?: {
    aPIKeys?: { edges?: Array<{ node?: { key?: string } }> };
  };
  errors?: unknown[];
}

export async function fetchNamespaceApiKeyForSession(
  sessionToken: string,
  namespaceId: string,
): Promise<string | undefined> {
  const cacheKey = `${sessionToken.slice(0, 20)}:${namespaceId}`;
  const cached = apiKeyCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.apiKey;
  }

  const response = await fetch(PARSE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Session-Token": sessionToken,
    },
    body: JSON.stringify({
      query: GET_NAMESPACE_API_KEYS,
      variables: { namespaceId },
    }),
  });

  if (!response.ok) {
    return undefined;
  }

  const json = (await response.json()) as ParseGraphQLResponse;
  if (json.errors?.length) {
    return undefined;
  }

  const apiKey = json.data?.aPIKeys?.edges?.[0]?.node?.key?.trim();
  if (!apiKey) {
    return undefined;
  }

  apiKeyCache.set(cacheKey, { apiKey, expiresAt: Date.now() + CACHE_TTL_MS });
  return apiKey;
}

function paprApiKeyMatchesNamespaceId(apiKey: string, namespaceId: string): boolean {
  const trimmed = apiKey.trim();
  const scope = parsePaprApiKeyScope(trimmed);
  if (scope) {
    return scope.namespaceId === namespaceId;
  }
  const activeNamespaceId =
    process.env.PAPR_NAMESPACE_ID?.trim() ||
    readActiveWorkspacePointer()?.namespaceId;
  return activeNamespaceId === namespaceId;
}

/** Attach a namespace-scoped paprApiKey; drop workspace keys for other namespaces. */
export async function enrichRuntimeAuthWithPaprApiKey(
  auth: AppRuntimeRouteAuth | null,
): Promise<AppRuntimeRouteAuth | null> {
  if (!auth) {
    return auth;
  }

  let paprApiKey = auth.paprApiKey;
  if (paprApiKey && !paprApiKeyMatchesNamespaceId(paprApiKey, auth.namespaceId)) {
    paprApiKey = undefined;
  } else if (paprApiKey) {
    return auth;
  }

  if (auth.sessionToken) {
    const namespaceKey = await fetchNamespaceApiKeyForSession(
      auth.sessionToken,
      auth.namespaceId,
    );
    if (namespaceKey) {
      paprApiKey = namespaceKey;
    }
  }

  if (paprApiKey === auth.paprApiKey) {
    return auth;
  }

  return { ...auth, paprApiKey };
}

export function runtimeAuthRequiresPaprApiKey(auth: AppRuntimeRouteAuth): boolean {
  return !auth.paprApiKey && !auth.shareToken;
}

export const APP_AGENT_SIGN_IN_MESSAGE =
  "Sign in to Papr to use the in-app assistant. Open apps.papr.ai and sign in with the account that owns or can access this app.";

export const APP_AGENT_CLOUD_JOB_MISSING_MESSAGE =
  "Cloud assistant job is missing from the published app. In Paprwork: confirm enable_app_agent_chat ran, then Sync now / republish so jobs.json and the hidden subagent job upload to the cloud.";
