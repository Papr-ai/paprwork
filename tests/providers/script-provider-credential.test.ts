// Jobs and app backend actions must run on the same provider credential as chat.
// The stored ANTHROPIC_API_KEY / OPENAI_API_KEY can lag the live sign-in, or hold
// an API key the user saved and then switched away from (OAuth ↔ API key toggle).
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/gateway/utils/keyResolver.js", () => ({
  getProviderAuth: vi.fn(),
}));

import { getProviderAuth } from "../../src/gateway/utils/keyResolver.js";
import {
  applyLiveProviderAuth,
  isProviderAuthKeyName,
} from "../../src/gateway/utils/scriptProviderCredential.js";

const auth = vi.mocked(getProviderAuth);

describe("applyLiveProviderAuth", () => {
  const savedMode = process.env.GATEWAY_MODE;
  beforeEach(() => {
    auth.mockReset();
    delete process.env.GATEWAY_MODE;
  });
  afterEach(() => {
    if (savedMode === undefined) delete process.env.GATEWAY_MODE;
    else process.env.GATEWAY_MODE = savedMode;
  });

  test("on OAuth, a stale stored key is replaced by the live sign-in token", async () => {
    auth.mockResolvedValue({ type: "oauth", token: "sk-ant-oat01-live" });
    const env = { ANTHROPIC_API_KEY: "sk-ant-api03-capped", OTHER: "x" };
    const injected = await applyLiveProviderAuth(env);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-oat01-live");
    expect(env.OTHER).toBe("x");
    expect(injected).toEqual(["sk-ant-oat01-live"]);
    expect(auth).toHaveBeenCalledWith("anthropic");
  });

  test("on API key mode the stored key is kept", async () => {
    auth.mockResolvedValue({ type: "apiKey", key: "sk-ant-api03-mine" });
    const env = { ANTHROPIC_API_KEY: "sk-ant-api03-mine" };
    expect(await applyLiveProviderAuth(env)).toEqual([]);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-mine");
  });

  test("only provider slots the script asked for are touched", async () => {
    auth.mockResolvedValue({ type: "oauth", token: "tok" });
    const env: Record<string, string> = { ANTHROPIC_API_OVERAGE: "sk-ant-api03-o" };
    await applyLiveProviderAuth(env);
    expect(env).toEqual({ ANTHROPIC_API_OVERAGE: "sk-ant-api03-o" });
    expect(auth).not.toHaveBeenCalled();
  });

  test("a failed lookup keeps the stored key", async () => {
    auth.mockRejectedValue(new Error("ipc timeout"));
    const env = { OPENAI_API_KEY: "sk-proj-stored" };
    await applyLiveProviderAuth(env);
    expect(env.OPENAI_API_KEY).toBe("sk-proj-stored");
  });

  test("cloud gateway leaves vault values alone", async () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    auth.mockResolvedValue({ type: "oauth", token: "tok" });
    const env = { ANTHROPIC_API_KEY: "vault" };
    await applyLiveProviderAuth(env);
    expect(env.ANTHROPIC_API_KEY).toBe("vault");
  });

  test("provider key names", () => {
    expect(isProviderAuthKeyName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isProviderAuthKeyName("OPENAI_API_KEY")).toBe(true);
    expect(isProviderAuthKeyName("ANTHROPIC_API_OVERAGE")).toBe(false);
  });
});
