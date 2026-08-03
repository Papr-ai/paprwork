import Papr from "@papr/memory";
import {
  formatPaprQuotaMessage,
  reportPaprQuotaError,
} from "../utils/paprQuota.js";

export async function getPaprClient(): Promise<Papr> {
  const { getPaprApiKey } = await import("../../gateway/utils/keyResolver.js");
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    throw new Error("PAPR_API_KEY is not configured");
  }
  // Memory server REST + /v1/graphql authenticate via X-API-Key. Do not send
  // PAPR_SESSION_TOKEN here — that Parse session is for dashboard/Parse APIs only;
  // sending both can make GraphQL take a JWT/JWKS path and fail with 401.
  return new Papr({
    xAPIKey: apiKey,
    maxRetries: 2,
    timeout: 120000,
  });
}

export function isPaprNotFoundError(error: unknown): boolean {
  return error instanceof Papr.NotFoundError;
}

export function handlePaprToolError(error: unknown, source = "papr-tool"): never {
  const quotaStatus = reportPaprQuotaError(error, source);
  if (quotaStatus) {
    throw new Error(formatPaprQuotaMessage(quotaStatus));
  }
  if (error instanceof Papr.AuthenticationError) {
    throw new Error(
      "Invalid PAPR API key. Please check your Settings and ensure your API key is correct.",
    );
  }
  throw error;
}
