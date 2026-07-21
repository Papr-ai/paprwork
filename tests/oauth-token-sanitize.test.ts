import { describe, expect, it } from "vitest";
import {
  extractChatGptAccountIdFromOAuthToken,
  sanitizeOAuthAccessToken,
} from "../src/core/utils/oauthTokenSanitize.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("sanitizeOAuthAccessToken", () => {
  it("preserves JWT dots for OpenAI OAuth tokens", () => {
    const jwt = makeJwt({ sub: "user-1" });
    const noisy = `  ${jwt}\n`;
    expect(sanitizeOAuthAccessToken("openai", noisy)).toBe(jwt);
  });

  it("strips invalid chars from Anthropic OAuth tokens", () => {
    const token = "sk-ant-oat01-abc_def";
    expect(sanitizeOAuthAccessToken("anthropic", ` ${token} `)).toBe(token);
  });
});

describe("extractChatGptAccountIdFromOAuthToken", () => {
  it("reads chatgpt_account_id from JWT claim", () => {
    const token = makeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-456" },
    });
    expect(extractChatGptAccountIdFromOAuthToken(token)).toBe("acct-456");
  });
});
