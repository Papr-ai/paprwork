import { describe, expect, it } from "vitest";
import {
  reconcileCloudProviderAuth,
  resolveCloudProviderAuthFromVaultKeys,
  resolveVaultKeySource,
} from "../src/gateway/services/cloudAgentGateway/resolveCloudProviderAuth.js";

describe("resolveVaultKeySource", () => {
  it("uses CustomKeys oauth metadata", () => {
    expect(
      resolveVaultKeySource(
        {
          name: "OPENAI_API_KEY",
          source: "oauth",
          managedBy: "oauth",
          oauthProvider: "openai",
          description: "ChatGPT Plus/Pro OAuth Token (Auto-managed)",
        },
        "x".repeat(1622),
      ),
    ).toBe("oauth");
  });

  it("detects oauth from auto-managed description", () => {
    expect(
      resolveVaultKeySource(
        {
          name: "OPENAI_API_KEY",
          description: "ChatGPT Plus/Pro OAuth Token (Auto-managed)",
        },
        "short-token",
      ),
    ).toBe("oauth");
  });

  it("does not guess oauth from token length alone", () => {
    expect(
      resolveVaultKeySource({ name: "OPENAI_API_KEY" }, "x".repeat(1622)),
    ).toBe("manual");
  });
});

describe("resolveCloudProviderAuthFromVaultKeys", () => {
  it("detects oauth from metadata source", () => {
    const result = resolveCloudProviderAuthFromVaultKeys({
      provider: "anthropic",
      keys: { ANTHROPIC_API_KEY: "sk-ant-oat-test" },
      keyMetadata: { ANTHROPIC_API_KEY: { source: "oauth" } },
    });
    expect(result?.authType).toBe("oauth");
  });

  it("detects oauth from sk-oat prefix", () => {
    const result = resolveCloudProviderAuthFromVaultKeys({
      provider: "openai",
      keys: { OPENAI_API_KEY: "sk-oat-test-token" },
    });
    expect(result?.authType).toBe("oauth");
  });

  it("detects apiKey for platform keys", () => {
    const result = resolveCloudProviderAuthFromVaultKeys({
      provider: "openai",
      keys: { OPENAI_API_KEY: "sk-platform-key" },
    });
    expect(result?.authType).toBe("apiKey");
  });
});

describe("reconcileCloudProviderAuth", () => {
  it("corrects apiKey to oauth for anthropic sk-ant-oat prefix", () => {
    const result = reconcileCloudProviderAuth({
      provider: "anthropic",
      token: "sk-ant-oat-test",
      authType: "apiKey",
    });
    expect(result.authType).toBe("oauth");
  });

  it("trusts oauth authType from memory server", () => {
    const token = "x".repeat(1622);
    const result = reconcileCloudProviderAuth({
      provider: "openai",
      token,
      authType: "oauth",
    });
    expect(result.authType).toBe("oauth");
  });

  it("corrects apiKey to oauth only for sk-oat prefix", () => {
    const result = reconcileCloudProviderAuth({
      provider: "openai",
      token: "sk-oat-test",
      authType: "apiKey",
    });
    expect(result.authType).toBe("oauth");
  });

  it("does not correct long opaque tokens without metadata", () => {
    const result = reconcileCloudProviderAuth({
      provider: "openai",
      token: "x".repeat(1622),
      authType: "apiKey",
    });
    expect(result.authType).toBe("apiKey");
  });
});
