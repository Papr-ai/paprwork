import { describe, expect, test } from "vitest";
import { PhaseTimer } from "../src/gateway/utils/phaseTiming.js";

describe("PhaseTimer", () => {
  test("records phase breakdown", () => {
    const timer = new PhaseTimer();
    timer.mark("a");
    timer.mark("b");
    expect(timer.formatPhases()).toMatch(/a=\d+ms b=\d+ms/);
    expect(timer.totalMs()).toBeGreaterThanOrEqual(0);
  });
});
