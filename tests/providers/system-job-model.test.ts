import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveSystemJobProviderModel } from "../../src/gateway/utils/systemJobModel.js";
import { DEFAULT_AUTO_LADDERS } from "../../src/core/agents/autoLadders.js";

vi.mock("../../src/gateway/utils/keyResolver.js", () => ({
  getProviderAuth: vi.fn(),
  getApiKeys: vi.fn(),
}));

import { getApiKeys, getProviderAuth } from "../../src/gateway/utils/keyResolver.js";

const strong = (p: "anthropic" | "openai" | "google") =>
  DEFAULT_AUTO_LADDERS[p]!.models.strong;

describe("resolveSystemJobProviderModel", () => {
  beforeEach(() => {
    vi.mocked(getProviderAuth).mockReset();
    vi.mocked(getApiKeys).mockReset();
    vi.mocked(getApiKeys).mockResolvedValue({});
  });

  test("keeps Claude when Claude is connected", async () => {
    vi.mocked(getProviderAuth).mockImplementation(async (p) =>
      p === "anthropic" ? { type: "oauth", token: "t" } : null,
    );
    expect(await resolveSystemJobProviderModel()).toEqual({
      provider: "anthropic",
      model: strong("anthropic"),
    });
  });

  test("uses OpenAI on ChatGPT sign-in when Claude is not connected", async () => {
    vi.mocked(getProviderAuth).mockImplementation(async (p) =>
      p === "openai" ? { type: "oauth", token: "t" } : null,
    );
    expect(await resolveSystemJobProviderModel()).toEqual({
      provider: "openai",
      model: strong("openai"),
    });
  });

  test("uses Google when only a Gemini key is set", async () => {
    vi.mocked(getProviderAuth).mockResolvedValue(null);
    vi.mocked(getApiKeys).mockResolvedValue({ GOOGLE_API_KEY: "g" });
    expect(await resolveSystemJobProviderModel()).toEqual({
      provider: "google",
      model: strong("google"),
    });
  });

  test("returns null with no direct connection (Papr proxy keeps stored default)", async () => {
    vi.mocked(getProviderAuth).mockResolvedValue(null);
    expect(await resolveSystemJobProviderModel()).toBeNull();
  });

  test("a failing auth lookup does not stop the search", async () => {
    vi.mocked(getProviderAuth).mockImplementation(async (p) => {
      if (p === "anthropic") throw new Error("ipc timeout");
      return { type: "apiKey", key: "sk" };
    });
    expect(await resolveSystemJobProviderModel()).toEqual({
      provider: "openai",
      model: strong("openai"),
    });
  });
});
