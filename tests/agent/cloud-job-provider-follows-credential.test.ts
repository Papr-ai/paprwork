import { describe, expect, it, vi } from "vitest";
vi.spyOn(console, "warn").mockImplementation(() => {});
import { pickCloudJobProviderModel } from "../../src/gateway/services/cloudAgentGateway/cloudAgentRunContext.js";

describe("cloud agent job: provider follows the credential", () => {
  it("keeps the job's provider and model when the credential matches", () => {
    expect(pickCloudJobProviderModel("openai", "gpt-5.4-mini", "openai")).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
    expect(pickCloudJobProviderModel("openai-codex", "gpt-5.5", "openai")).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  });

  it("switches to the credential's provider after a memory fallback (never sends a Google key to OpenAI)", () => {
    expect(pickCloudJobProviderModel("openai", "gpt-5.4-mini", "google")).toEqual({ provider: "google", model: undefined });
    expect(pickCloudJobProviderModel("anthropic", "claude-sonnet-5-5", "openai")).toEqual({ provider: "openai", model: undefined });
  });

  it("uses the credential's provider when the job names none", () => {
    expect(pickCloudJobProviderModel(undefined, undefined, "google")).toEqual({ provider: "google", model: undefined });
  });
});
