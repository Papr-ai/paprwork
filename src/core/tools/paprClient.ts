import Papr from "@papr/memory";

export async function getPaprClient(): Promise<Papr> {
  const { getApiKey } = await import("../../gateway/utils/keyResolver.js");
  const apiKey = await getApiKey("PAPR_API_KEY");
  if (!apiKey) {
    throw new Error("PAPR_API_KEY is not configured");
  }
  const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
  return new Papr({
    xAPIKey: apiKey,
    ...(sessionToken ? { xSessionToken: sessionToken } : {}),
    maxRetries: 2,
    timeout: 120000,
  });
}

export function isPaprNotFoundError(error: unknown): boolean {
  return error instanceof Papr.NotFoundError;
}

export function handlePaprToolError(error: unknown): never {
  if (error instanceof Papr.RateLimitError || error instanceof Papr.PermissionDeniedError) {
    throw new Error(
      "Papr Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings to continue using memory features.",
    );
  }
  if (error instanceof Papr.AuthenticationError) {
    throw new Error(
      "Invalid PAPR API key. Please check your Settings and ensure your API key is correct.",
    );
  }
  throw error;
}
