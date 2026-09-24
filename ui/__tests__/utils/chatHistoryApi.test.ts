import { describe, expect, it } from "vitest";
import { getRemainingHistoryBatchSize } from "../../utils/chatHistoryApi";

describe("getRemainingHistoryBatchSize", () => {
  it("requests every known earlier message for a long chat", () => {
    expect(
      getRemainingHistoryBatchSize({
        loadedMessageCount: 30,
        knownMessageCount: 641,
      }),
    ).toBe(611);
  });

  it("uses a safe page when the total is unavailable", () => {
    expect(getRemainingHistoryBatchSize({ loadedMessageCount: 30 })).toBe(20);
  });

  it("never sends a non-positive limit for stale metadata", () => {
    expect(
      getRemainingHistoryBatchSize({
        loadedMessageCount: 50,
        knownMessageCount: 30,
      }),
    ).toBe(20);
  });
});
