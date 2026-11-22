import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveSystemJobProviderModel } from "../../src/gateway/utils/systemJobModel.js";
import { findReachableProvider } from "../../src/gateway/utils/reachableProvider.js";
import { DEFAULT_AUTO_LADDERS } from "../../src/core/agents/autoLadders.js";

vi.mock("../../src/gateway/utils/resolveAgentProviderCredentials.js", () => ({
  resolveAgentProviderCredentials: vi.fn(),
}));

import { resolveAgentProviderCredentials } from "../../src/gateway/utils/resolveAgentProviderCredentials.js";

const strong = (p: "anthropic" | "openai" | "google") =>
  DEFAULT_AUTO_LADDERS[p]!.models.strong;
const direct = { apiKey: "k", authType: "oauth" as const };
const proxy = { apiKey: "papr", authType: "apiKey" as const, usePaprProxy: true };

function connected(map: Partial<Record<string, typeof direct | typeof proxy>>) {
  vi.mocked(resolveAgentProviderCredentials).mockImplementation(
    async (p) => map[p] ?? null,
  );
}

describe("resolveSystemJobProviderModel", () => {
  beforeEach(() => vi.mocked(resolveAgentProviderCredentials).mockReset());

  test("keeps Claude when Claude is connected", async () => {
    connected({ anthropic: direct, openai: direct });
    expect(await resolveSystemJobProviderModel()).toEqual({
      provider: "anthropic",
      model: strong("anthropic"),
    });
  });

  test("ChatGPT-only user on Papr login: skips Claude-via-proxy, uses OpenAI", async () => {
    connected({ anthropic: proxy, openai: direct, google: proxy });
    expect(await resolveSystemJobProviderModel()).toEqual({
      provider: "openai",
      model: strong("openai"),
    });
  });

  test("uses Google when only a Gemini key is set", async () => {
    connected({ anthropic: proxy, openai: proxy, google: { apiKey: "g", authType: "apiKey" } });
    expect(await resolveSystemJobProviderModel()).toEqual({
      provider: "google",
      model: strong("google"),
    });
  });

  test("returns null when only the Papr proxy is available", async () => {
    connected({ anthropic: proxy, openai: proxy, google: proxy });
    expect(await resolveSystemJobProviderModel()).toBeNull();
  });

  test("a failing credential lookup does not stop the search", async () => {
    vi.mocked(resolveAgentProviderCredentials).mockImplementation(async (p) => {
      if (p === "anthropic") throw new Error("ipc timeout");
      return direct;
    });
    expect(await resolveSystemJobProviderModel()).toEqual({
      provider: "openai",
      model: strong("openai"),
    });
  });
});

describe("findReachableProvider directOnly", () => {
  beforeEach(() => vi.mocked(resolveAgentProviderCredentials).mockReset());

  test("default still accepts the Papr proxy (chat / retry behaviour unchanged)", async () => {
    connected({ anthropic: proxy });
    const r = await findReachableProvider();
    expect(r?.provider).toBe("anthropic");
    expect(r?.creds.usePaprProxy).toBe(true);
  });
});
