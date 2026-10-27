import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/gateway/utils/resolveAgentProviderCredentials.js", () => ({
  resolveAgentProviderCredentials: vi.fn(),
}));

import { resolveAgentProviderCredentials } from "../../src/gateway/utils/resolveAgentProviderCredentials.js";
import { findReachableProvider } from "../../src/gateway/utils/reachableProvider.js";

const creds = { apiKey: "k", authType: "apiKey" as const };

describe("findReachableProvider", () => {
  afterEach(() => vi.resetAllMocks());

  it("prefers Anthropic when configured", async () => {
    vi.mocked(resolveAgentProviderCredentials).mockResolvedValue(creds);
    expect((await findReachableProvider())?.provider).toBe("anthropic");
  });

  it("skips Anthropic and lands on OpenAI, then Google", async () => {
    vi.mocked(resolveAgentProviderCredentials).mockImplementation(async (p) =>
      p === "anthropic" ? null : creds,
    );
    expect((await findReachableProvider())?.provider).toBe("openai");

    vi.mocked(resolveAgentProviderCredentials).mockImplementation(async (p) =>
      p === "google" ? creds : null,
    );
    expect((await findReachableProvider())?.provider).toBe("google");
  });

  it("honours exclusions and returns null when nothing is reachable", async () => {
    vi.mocked(resolveAgentProviderCredentials).mockResolvedValue(creds);
    expect((await findReachableProvider(["anthropic"]))?.provider).toBe("openai");
    vi.mocked(resolveAgentProviderCredentials).mockResolvedValue(null);
    expect(await findReachableProvider()).toBeNull();
  });

  it("treats a throwing resolver as unreachable", async () => {
    vi.mocked(resolveAgentProviderCredentials).mockImplementation(async (p) => {
      if (p === "anthropic") throw new Error("keychain locked");
      return creds;
    });
    expect((await findReachableProvider())?.provider).toBe("openai");
  });
});
