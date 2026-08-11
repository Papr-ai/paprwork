import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  extractChatGptAccountIdFromToken,
  isJwtExpired,
  resolveDefaultProviderFromVaultEnv,
  resolveJobProviderModel,
  resolveOpenAIKeyAuthType,
  resolveUsableCloudCredentials,
} from "../src/gateway/utils/resolveJobProviderModel.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function makeValidOpenAiOAuthJwt(accountId = "acct-123"): string {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

describe("extractChatGptAccountIdFromToken", () => {
  it("extracts chatgpt_account_id from JWT payload", () => {
    const token = makeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    });
    expect(extractChatGptAccountIdFromToken(token)).toBe("acct-123");
  });

  it("returns undefined when claim missing", () => {
    expect(extractChatGptAccountIdFromToken("sk-oat-not-a-jwt")).toBeUndefined();
  });
});

describe("resolveOpenAIKeyAuthType", () => {
  it("returns oauth when accountId present", () => {
    const token = makeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    });
    expect(resolveOpenAIKeyAuthType(`sk-oat-${token}`)).toBe("oauth");
  });

  it("returns null for oauth-shaped token without accountId", () => {
    expect(resolveOpenAIKeyAuthType("sk-oat-broken-token")).toBeNull();
    expect(resolveOpenAIKeyAuthType("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig")).toBeNull();
  });

  it("returns null for expired oauth token with accountId", () => {
    const token = makeJwt({
      exp: Math.floor(Date.now() / 1000) - 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    });
    expect(resolveOpenAIKeyAuthType(`sk-oat-${token}`)).toBeNull();
  });

  it("returns apiKey for platform keys", () => {
    expect(resolveOpenAIKeyAuthType("sk-proj-platform-key")).toBe("apiKey");
  });
});

describe("isJwtExpired", () => {
  it("detects expired JWT", () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    expect(isJwtExpired(token)).toBe(true);
  });

  it("returns false for valid JWT", () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(isJwtExpired(token)).toBe(false);
  });
});

describe("resolveUsableCloudCredentials", () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  });

  it("falls back to Anthropic when OpenAI OAuth token is expired", () => {
    const expired = makeJwt({
      exp: Math.floor(Date.now() / 1000) - 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    });
    process.env.OPENAI_API_KEY = `sk-oat-${expired}`;
    process.env.ANTHROPIC_API_KEY = "sk-ant-oat-anthropic";

    expect(resolveUsableCloudCredentials()).toEqual({
      provider: "anthropic",
      model: DEFAULT_MODEL_BY_PROVIDER.anthropic,
      token: "sk-ant-oat-anthropic",
      authType: "oauth",
    });
  });

  it("falls back to Anthropic when OpenAI OAuth token is unusable", () => {
    process.env.OPENAI_API_KEY = "sk-oat-broken-token";
    process.env.ANTHROPIC_API_KEY = "sk-ant-oat-anthropic";

    expect(resolveUsableCloudCredentials()).toEqual({
      provider: "anthropic",
      model: DEFAULT_MODEL_BY_PROVIDER.anthropic,
      token: "sk-ant-oat-anthropic",
      authType: "oauth",
    });
  });
});

describe("resolveDefaultProviderFromVaultEnv", () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GATEWAY_MODE;
  });

  it("prefers OpenAI OAuth token over Anthropic", () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    process.env.OPENAI_API_KEY = `sk-oat-${makeValidOpenAiOAuthJwt()}`;
    process.env.ANTHROPIC_API_KEY = "sk-ant-oat-anthropic";

    expect(resolveDefaultProviderFromVaultEnv()).toEqual({
      provider: "openai",
      model: "gpt-5.6-sol",
    });
  });

  it("throws when no vault keys present on cloud", () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    expect(() => resolveDefaultProviderFromVaultEnv()).toThrow(
      /No usable LLM credentials/,
    );
  });

  it("falls back to Anthropic when OpenAI key missing", () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    process.env.ANTHROPIC_API_KEY = "sk-ant-oat-anthropic";

    expect(resolveDefaultProviderFromVaultEnv()).toEqual({
      provider: "anthropic",
      model: DEFAULT_MODEL_BY_PROVIDER.anthropic,
    });
  });

  it("uses Google when only Google key present", () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-key";

    expect(resolveDefaultProviderFromVaultEnv()).toEqual({
      provider: "google",
      model: DEFAULT_MODEL_BY_PROVIDER.google,
    });
  });
});

describe("resolveJobProviderModel", () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GATEWAY_MODE;
    vi.resetModules();
  });

  it("normalizes legacy gpt-5.5 to gpt-5-6-sol on cloud", async () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    process.env.OPENAI_API_KEY = `sk-oat-${makeValidOpenAiOAuthJwt()}`;

    const result = await resolveJobProviderModel({
      provider: "openai",
      model: "gpt-5.5",
    });

    expect(result).toEqual({
      provider: "openai",
      model: "gpt-5.6-sol",
    });
  });

  it("uses provider-specific default when model omitted on cloud", async () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    process.env.ANTHROPIC_API_KEY = "sk-ant-oat-token";

    const result = await resolveJobProviderModel({
      provider: "anthropic",
    });

    expect(result).toEqual({
      provider: "anthropic",
      model: DEFAULT_MODEL_BY_PROVIDER.anthropic,
    });
  });
});
