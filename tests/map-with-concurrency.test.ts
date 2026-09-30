import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/gateway/utils/mapWithConcurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves order", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it("limits in-flight work", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});
