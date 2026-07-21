import { describe, expect, it } from "vitest";
import {
  isExpectedStreamCancellation,
  STREAM_REPLACED_REASON,
} from "../src/core/constants/streamCancellation.js";

describe("streamCancellation", () => {
  it("treats replacement and user stop as expected cancellation", () => {
    expect(isExpectedStreamCancellation(STREAM_REPLACED_REASON)).toBe(true);
    expect(isExpectedStreamCancellation("Stopped by user")).toBe(true);
    expect(isExpectedStreamCancellation("aborted")).toBe(true);
    expect(isExpectedStreamCancellation("The user aborted a request")).toBe(
      true,
    );
  });

  it("does not treat provider failures as expected cancellation", () => {
    expect(isExpectedStreamCancellation("Rate limit exceeded")).toBe(false);
    expect(isExpectedStreamCancellation("Internal Server Error")).toBe(false);
  });
});
