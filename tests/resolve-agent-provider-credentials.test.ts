import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getApiKeys: vi.fn(),
  getPaprApiKey: vi.fn(),
  getProviderAuthForModel: vi.fn(),
  resolvePaprProxyAuth: vi.fn(),
  PAPR_PROXY_SIGN_IN_MESSAGE: "Sign in with Papr",
}));

import {
  getApiKeys,
  getProviderAuthForModel,
  resolvePaprProxyAuth,
} from "../src/gateway/utils/keyResolver.js";
import { resolveAgentProviderCredentials } from "../src/gateway/utils/resolveAgentProviderCredentials.js";
import { resolveJobSessionAuth } from "../src/gateway/utils/resolveJobSessionAuth.js";

describe("resolveAgentProviderCredentials", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("uses Papr proxy when direct Anthropic auth is missing", async () => {
    vi.mocked(getProviderAuthForModel).mockResolvedValue(null);
    vi.mocked(resolvePaprProxyAuth).mockResolvedValue({
      apiKey: "sk-papr-test",
      usePaprProxy: true,
    });

    const creds = await resolveAgentProviderCredentials(
      "anthropic",
      "claude-opus-4-6",
    );

    expect(creds).toEqual({
      apiKey: "sk-papr-test",
      authType: "apiKey",
      usePaprProxy: true,
    });
    expect(resolvePaprProxyAuth).toHaveBeenCalled();
  });

  it("prefers direct OAuth over Papr proxy", async () => {
    vi.mocked(getProviderAuthForModel).mockResolvedValue({
      type: "oauth",
      token: "oauth-token",
    });

    const creds = await resolveAgentProviderCredentials(
      "anthropic",
      "claude-sonnet-5-5",
    );

    expect(creds).toEqual({
      apiKey: "oauth-token",
      authType: "oauth",
    });
    expect(resolvePaprProxyAuth).not.toHaveBeenCalled();
  });

  it("uses Papr proxy for Google when GOOGLE_API_KEY is missing", async () => {
    vi.mocked(getApiKeys).mockResolvedValue({});
    vi.mocked(resolvePaprProxyAuth).mockResolvedValue({
      apiKey: "sk-papr-test",
      usePaprProxy: true,
    });

    const creds = await resolveAgentProviderCredentials(
      "google",
      "gemini-3.8-flash",
    );

    expect(creds?.usePaprProxy).toBe(true);
    expect(getApiKeys).toHaveBeenCalledWith(["GOOGLE_API_KEY"]);
  });
});

describe("resolveJobSessionAuth", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("does not fall back to Ollama when Papr proxy satisfies the job profile", async () => {
    vi.mocked(getProviderAuthForModel).mockResolvedValue(null);
    vi.mocked(resolvePaprProxyAuth).mockResolvedValue({
      apiKey: "sk-papr-test",
      usePaprProxy: true,
    });

    const session = await resolveJobSessionAuth({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    expect(session.provider).toBe("anthropic");
    expect(session.model).toBe("claude-opus-4-6");
    expect(session.usePaprProxy).toBe(true);
  });
});
