import { describe, expect, it } from "vitest";
import { turnPeakFillPercent } from "../ui/components/Chat/contextMeterModel";

describe("turnPeakFillPercent", () => {
  it("uses peak over effective window (not history budget alone)", () => {
    expect(
      turnPeakFillPercent(
        {
          peakContextTokens: 228_000,
          promptTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        200_000,
      ),
    ).toBe(114);
  });

  it("falls back to billed request when peak missing", () => {
    expect(
      turnPeakFillPercent(
        {
          peakContextTokens: null,
          promptTokens: 50_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        200_000,
      ),
    ).toBe(25);
  });
});
