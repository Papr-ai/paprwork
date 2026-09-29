import { describe, expect, it } from "vitest";
import {
  AUTO_TIERS,
  DEFAULT_AUTO_LADDERS,
  resolveAutoRung,
  roundUpTier,
  routeTurn,
  type AutoRouteDecision,
} from "../src/gateway/services/agent/jevTurnRouter.js";

const decision = (tier: AutoRouteDecision["tier"], confidence = 0.9): AutoRouteDecision => ({
  tier,
  rawTier: tier,
  confidence,
  needsTools: false,
  jevMs: 12,
});

describe("Auto model routing", () => {
  it("ladder: trivial→Haiku, Sonnet low/medium/high, hard→Opus high", () => {
    const a = DEFAULT_AUTO_LADDERS.anthropic!;
    expect(a.trivial).toEqual({ model: "claude-haiku-4-5" });
    expect(a.light).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    expect(a.standard).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(a.deep).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
    expect(a.hard).toEqual({ model: "claude-opus-5-5", effort: "high" });
  });

  it("every provider ladder covers every tier", () => {
    for (const ladder of Object.values(DEFAULT_AUTO_LADDERS)) {
      for (const tier of AUTO_TIERS) expect(ladder[tier].model).toBeTruthy();
    }
  });

  it("low confidence rounds the tier UP, never down; hard stays hard", () => {
    expect(roundUpTier("trivial", 0.4)).toBe("light");
    expect(roundUpTier("standard", 0.59)).toBe("deep");
    expect(roundUpTier("standard", 0.6)).toBe("standard");
    expect(roundUpTier("hard", 0.1)).toBe("hard");
  });

  it("routeTurn returns null when Jev gives no decision (caller keeps config)", async () => {
    const pick = await routeTurn("anthropic", { userMessage: "hi" }, async () => null);
    expect(pick).toBeNull();
  });

  it("routeTurn returns null for a provider without a ladder", async () => {
    const pick = await routeTurn("ollama", { userMessage: "hi" }, async () => decision("hard"));
    expect(pick).toBeNull();
  });

  it("routeTurn maps the decision through the provider ladder", async () => {
    const pick = await routeTurn("anthropic", { userMessage: "why is the build failing?" }, async () =>
      decision("deep"),
    );
    expect(pick?.rung).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
    expect(resolveAutoRung("openai", "trivial")).toEqual({ model: "gpt-5.4-mini", effort: "low" });
  });
});
