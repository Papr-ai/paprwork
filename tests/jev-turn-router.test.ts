import { describe, expect, it } from "vitest";
import {
  AUTO_CAPABILITIES,
  AUTO_EFFORTS,
  DEFAULT_AUTO_LADDERS,
  resolveAutoRung,
  roundUp,
  routeTurn,
  type AutoRouteDecision,
} from "../src/gateway/services/agent/jevTurnRouter.js";

const decision = (
  capability: AutoRouteDecision["capability"],
  effort: AutoRouteDecision["effort"],
): AutoRouteDecision => ({
  capability,
  rawCapability: capability,
  capabilityConfidence: 0.9,
  effort,
  rawEffort: effort,
  effortConfidence: 0.9,
  needsTools: false,
  jevMs: 12,
});

describe("Auto model routing — capability × effort", () => {
  it("Sonnet and Opus both take low/medium/high; Haiku takes none", () => {
    for (const effort of AUTO_EFFORTS) {
      expect(resolveAutoRung("anthropic", "strong", effort)).toEqual({
        model: "claude-sonnet-5-5",
        effort,
      });
      expect(resolveAutoRung("anthropic", "frontier", effort)).toEqual({
        model: "claude-opus-5-5",
        effort,
      });
    }
    expect(resolveAutoRung("anthropic", "basic", "high")).toEqual({ model: "claude-haiku-4-5" });
  });

  it("Gemini rungs never carry an effort", () => {
    for (const cap of AUTO_CAPABILITIES) {
      expect(resolveAutoRung("google", cap, "high")?.effort).toBeUndefined();
    }
  });

  it("every provider ladder covers every capability", () => {
    for (const ladder of Object.values(DEFAULT_AUTO_LADDERS)) {
      for (const cap of AUTO_CAPABILITIES) expect(ladder.models[cap]).toBeTruthy();
    }
  });

  it("low confidence rounds UP on each axis independently; top stays top", () => {
    expect(roundUp(AUTO_CAPABILITIES, "basic", 0.4)).toBe("strong");
    expect(roundUp(AUTO_CAPABILITIES, "strong", 0.6)).toBe("strong");
    expect(roundUp(AUTO_CAPABILITIES, "frontier", 0.1)).toBe("frontier");
    expect(roundUp(AUTO_EFFORTS, "low", 0.3)).toBe("medium");
    expect(roundUp(AUTO_EFFORTS, "high", 0.0)).toBe("high");
  });

  it("routeTurn: null decision or no ladder → caller keeps its config", async () => {
    expect(await routeTurn("anthropic", { userMessage: "hi" }, async () => null)).toBeNull();
    expect(
      await routeTurn("ollama", { userMessage: "hi" }, async () => decision("frontier", "high")),
    ).toBeNull();
  });

  it("routeTurn maps both axes through the provider ladder", async () => {
    const pick = await routeTurn(
      "anthropic",
      { userMessage: "is this schema design sound?" },
      async () => decision("frontier", "low"),
    );
    expect(pick?.rung).toEqual({ model: "claude-opus-5-5", effort: "low" });
    const oa = await routeTurn("openai", { userMessage: "hey" }, async () => decision("basic", "low"));
    expect(oa?.rung).toEqual({ model: "gpt-5.4-mini", effort: "low" });
  });
});

describe("Auto in the picker and defaults", () => {
  it("getPickerModels pins auto first even when the saved list predates it", async () => {
    const { getPickerModels } = await import("../ui/constants/modelPicker.js");
    const ids = getPickerModels(["claude-sonnet-5-5", "gpt-5.5"]).map((m) => m.id);
    expect(ids[0]).toBe("auto");
    expect(ids.filter((id) => id === "auto")).toHaveLength(1);
  });

  it("new chats default to auto on any cloud path; local-only stays local", async () => {
    const { resolveGlobalDefaultForAuth } = await import("../ui/utils/authAwareModelDefaults.js");
    const base = {
      anthropic: { oauth: false, apiKey: false },
      openai: { oauth: false, apiKey: false },
      google: { apiKey: false },
      paprProxy: false,
    } as any;
    expect(resolveGlobalDefaultForAuth({ ...base, paprProxy: true })).toBe("auto");
    expect(resolveGlobalDefaultForAuth({ ...base, google: { apiKey: true } })).toBe("auto");
    expect(resolveGlobalDefaultForAuth(base)).not.toBe("auto");
  });

  it("resolveAutoProvider follows the best reachable provider, not the catalog entry", async () => {
    const { resolveAutoProvider } = await import("../ui/utils/buildAgentConfig.js");
    const only = (p: "anthropic" | "openai" | "google") =>
      ({
        anthropic: { oauth: false, apiKey: p === "anthropic" },
        openai: { oauth: false, apiKey: p === "openai" },
        google: { apiKey: p === "google" },
        paprProxy: false,
      }) as any;
    expect(resolveAutoProvider(only("google"))).toBe("google");
    expect(resolveAutoProvider(only("openai"))).toBe("openai");
    expect(resolveAutoProvider(only("anthropic"))).toBe("anthropic");
    expect(resolveAutoProvider(undefined)).toBe("anthropic");
  });
});
