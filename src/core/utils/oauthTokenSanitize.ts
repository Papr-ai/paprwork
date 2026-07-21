const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** Strip paste/terminal noise without breaking JWT segment separators. */
export function sanitizeOAuthAccessToken(
  provider: "openai" | "anthropic",
  accessToken: string,
): string {
  const withoutAnsi = accessToken
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF]/g, "");

  if (provider === "openai") {
    // ChatGPT OAuth access tokens are JWTs — dots are required separators.
    return withoutAnsi.replace(/[^a-zA-Z0-9_.-]/g, "");
  }

  return withoutAnsi.replace(/[^a-zA-Z0-9_-]/g, "");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const decoded = Buffer.from(payload, "base64url").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract ChatGPT account id from OAuth JWT (pi-ai Codex routes require this). */
export function extractChatGptAccountIdFromOAuthToken(
  accessToken: string,
): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  const auth = payload[JWT_CLAIM_PATH] as
    | { chatgpt_account_id?: string }
    | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0
    ? accountId
    : undefined;
}
