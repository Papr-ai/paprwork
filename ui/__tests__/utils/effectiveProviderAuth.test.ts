import { describe, it, expect } from "vitest";
import {
  resolveEffectiveAuth,
  resolveEffectiveAuthForModel,
} from "../../utils/effectiveProviderAuth";

describe("resolveEffectiveAuth", () => {
  it("bills the key when the user picked API key, even with a live subscription", () => {
    // The reported bug: Claude connected via OAuth *and* a Platform key saved,
    // toggle set to API key. Main withholds the token, so the turn runs on the
    // key — the panel must not offer to report plan usage.
    expect(
      resolveEffectiveAuth({
        oauth: true,
        apiKey: true,
        preference: "apiKey",
      }),
    ).toBe("apiKey");
  });

  it("reports no direct auth when API key is picked but none is saved", () => {
    // Main withholds OAuth unconditionally on this preference — it does not
    // check that a key exists first. Falling back to "oauth" here would put us
    // back to describing a credential the gateway was never handed.
    expect(
      resolveEffectiveAuth({
        oauth: true,
        apiKey: false,
        preference: "apiKey",
      }),
    ).toBeNull();
  });

  it("prefers OAuth when that is the choice and both exist", () => {
    expect(
      resolveEffectiveAuth({ oauth: true, apiKey: true, preference: "oauth" }),
    ).toBe("oauth");
  });

  it("falls back to the key when OAuth is chosen but absent", () => {
    expect(
      resolveEffectiveAuth({ oauth: false, apiKey: true, preference: "oauth" }),
    ).toBe("apiKey");
  });

  it("reports nothing when the provider has no credentials at all", () => {
    expect(
      resolveEffectiveAuth({ oauth: false, apiKey: false, preference: "oauth" }),
    ).toBeNull();
  });
});

describe("resolveEffectiveAuthForModel", () => {
  it("forces the Platform key for models retired from ChatGPT OAuth", () => {
    // gpt-5.3-codex only runs on a Platform key, so the gateway ignores the
    // preference — and a plan readout would be wrong even on a live ChatGPT sub.
    expect(
      resolveEffectiveAuthForModel(
        { oauth: true, apiKey: true, preference: "oauth" },
        { id: "gpt-5.3-codex", provider: "openai-codex" },
      ),
    ).toBe("apiKey");
  });

  it("reports no auth for a Platform-only model with no key saved", () => {
    expect(
      resolveEffectiveAuthForModel(
        { oauth: true, apiKey: false, preference: "oauth" },
        { id: "gpt-5.3-codex", provider: "openai-codex" },
      ),
    ).toBeNull();
  });

  it("leaves ordinary models to the normal preference rules", () => {
    expect(
      resolveEffectiveAuthForModel(
        { oauth: true, apiKey: true, preference: "apiKey" },
        { id: "claude-opus-5", provider: "anthropic" },
      ),
    ).toBe("apiKey");
  });
});
