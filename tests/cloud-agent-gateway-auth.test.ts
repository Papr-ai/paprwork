import { describe, expect, it } from "vitest";
import { resolveCloudProviderAuthFromVaultKeys } from "../src/gateway/services/cloudAgentGateway/resolveCloudProviderAuth.js";

describe("resolveCloudProviderAuthFromVaultKeys", () => {
  it("detects oauth from metadata source", () => {
    const result = resolveCloudProviderAuthFromVaultKeys({
      provider: "anthropic",
      keys: { ANTHROPIC_API_KEY: "sk-ant-oat-test" },
      keyMetadata: { ANTHROPIC_API_KEY: { source: "oauth" } },
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
