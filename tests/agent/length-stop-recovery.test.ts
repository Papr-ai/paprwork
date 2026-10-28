import { describe, expect, it } from "vitest";
import {
  LENGTH_STOP_RECOVERY_NUDGE,
  shouldRecoverFromLengthStop,
  withLowEffort,
} from "../../src/gateway/services/agent/lengthStopRecovery.js";

const capped = {
  finishReason: "length",
  stepText: "",
  toolCallCount: 0,
  recoveriesUsed: 0,
  aborted: false,
  textOnlyStep: false,
};

describe("shouldRecoverFromLengthStop", () => {
  it("recovers a step cut off by the cap with no text and no tool call", () => {
    expect(shouldRecoverFromLengthStop(capped)).toBe(true);
  });

  it("leaves normal stops, partial replies and tool steps alone", () => {
    expect(shouldRecoverFromLengthStop({ ...capped, finishReason: "stop" })).toBe(false);
    expect(shouldRecoverFromLengthStop({ ...capped, stepText: "Here is" })).toBe(false);
    expect(shouldRecoverFromLengthStop({ ...capped, toolCallCount: 1 })).toBe(false);
  });

  it("recovers once per turn, never after abort or in a text-only step", () => {
    expect(shouldRecoverFromLengthStop({ ...capped, recoveriesUsed: 1 })).toBe(false);
    expect(shouldRecoverFromLengthStop({ ...capped, aborted: true })).toBe(false);
    expect(shouldRecoverFromLengthStop({ ...capped, textOnlyStep: true })).toBe(false);
  });

  it("tells the model to build one file per tool call", () => {
    expect(LENGTH_STOP_RECOVERY_NUDGE).toContain("ran out of output while planning");
    expect(LENGTH_STOP_RECOVERY_NUDGE).toContain("one file per tool call");
  });
});

describe("withLowEffort", () => {
  it("lowers adaptive effort written by an existing payload hook", async () => {
    const opts = withLowEffort({
      reasoning: "high",
      onPayload: (p: Record<string, unknown>) => ({
        ...p,
        thinking: { type: "adaptive" },
        output_config: { effort: "max", format: "x" },
      }),
    });
    expect(opts.reasoning).toBe("low");
    const out = await opts.onPayload!({ max_tokens: 40192 }, {});
    expect(out).toEqual({
      max_tokens: 40192,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: "x" },
    });
  });

  it("leaves payloads without an effort untouched", async () => {
    const opts = withLowEffort({ reasoning: "medium" });
    expect(await opts.onPayload!({ a: 1 }, {})).toEqual({ a: 1 });
  });
});
