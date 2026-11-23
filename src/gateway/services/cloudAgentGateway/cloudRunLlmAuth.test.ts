import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloudRunHelperAuth,
  getActiveCloudRunLlmAuth,
  setActiveCloudRunLlmAuth,
} from "./cloudRunLlmAuth.js";

const saved = { ...process.env };

describe("helper agents inside a cloud run use the run's credential", () => {
  beforeEach(() => {
    process.env.GATEWAY_MODE = "cloud_agent";
    setActiveCloudRunLlmAuth({ provider: "anthropic", authType: "oauth", token: "tok" });
  });
  afterEach(() => {
    setActiveCloudRunLlmAuth(null);
    process.env = { ...saved };
  });

  it("same provider keeps the helper's model", () => {
    expect(cloudRunHelperAuth("anthropic", "claude-opus-4-6")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
      authOverride: { apiKey: "tok", authType: "oauth" },
    });
  });

  it("other provider switches to the credential's provider (resolver picks the model)", () => {
    expect(cloudRunHelperAuth("openai", "gpt-5-6-sol")).toMatchObject({
      provider: "anthropic",
      model: undefined,
    });
  });

  it("cleared at run end, and never on desktop", () => {
    setActiveCloudRunLlmAuth(null);
    expect(cloudRunHelperAuth("anthropic", "x")).toBeNull();
    setActiveCloudRunLlmAuth({ provider: "anthropic", authType: "oauth", token: "tok" });
    delete process.env.GATEWAY_MODE;
    expect(getActiveCloudRunLlmAuth()).toBeNull();
  });
});

describe("cloud gateway never falls back to local Ollama", () => {
  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
    vi.doUnmock("./../../utils/keyResolver.js");
  });

  it("throws a clear error instead of picking ollama", async () => {
    vi.resetModules();
    vi.doMock("../../utils/keyResolver.js", () => ({
      getProviderAuth: async () => null,
      getApiKeys: async () => ({}),
      getPaprApiKey: async () => undefined,
    }));
    process.env.GATEWAY_MODE = "cloud_agent";
    const { getDefaultProviderAndModel, CloudNoCredentialError } = await import(
      "../../utils/defaultProvider.js"
    );
    await expect(getDefaultProviderAndModel()).rejects.toBeInstanceOf(CloudNoCredentialError);
  });

  it("desktop still falls back to ollama", async () => {
    vi.resetModules();
    vi.doMock("../../utils/keyResolver.js", () => ({
      getProviderAuth: async () => null,
      getApiKeys: async () => ({}),
      getPaprApiKey: async () => undefined,
    }));
    delete process.env.GATEWAY_MODE;
    const { getDefaultProviderAndModel } = await import("../../utils/defaultProvider.js");
    expect((await getDefaultProviderAndModel()).provider).toBe("ollama");
  });
});

describe("Papr AI proxy credential (no usable vault key)", () => {
  it("reconcile keeps usePaprProxy and never reinterprets the Papr key", async () => {
    const { reconcileCloudProviderAuth } = await import("./resolveCloudProviderAuth.js");
    expect(
      reconcileCloudProviderAuth({ provider: "anthropic", token: " sk-org-abc ", authType: "apiKey", usePaprProxy: true }),
    ).toEqual({ provider: "anthropic", authType: "apiKey", token: "sk-org-abc", usePaprProxy: true });
    expect(
      reconcileCloudProviderAuth({ provider: "anthropic", token: "sk-ant-api-x", authType: "apiKey" }).usePaprProxy,
    ).toBeUndefined();
  });

  it("helper jobs inherit the proxy route", () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    setActiveCloudRunLlmAuth({ provider: "anthropic", authType: "apiKey", token: "sk-org-abc", usePaprProxy: true });
    expect(cloudRunHelperAuth("anthropic", "claude-sonnet-4-6")?.authOverride).toEqual({
      apiKey: "sk-org-abc",
      authType: "apiKey",
      usePaprProxy: true,
    });
    setActiveCloudRunLlmAuth(null);
  });
});
