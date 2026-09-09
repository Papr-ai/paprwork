import { describe, expect, it } from "vitest";
import {
  isExpectedStreamCancellation,
  isRecoverableProviderStreamDrop,
  STREAM_STOPPED_BY_USER_REASON,
} from "../src/core/constants/streamCancellation.js";

describe("isRecoverableProviderStreamDrop", () => {
  it("treats undici terminated and socket errors as recoverable", () => {
    expect(isRecoverableProviderStreamDrop("terminated")).toBe(true);
    expect(isRecoverableProviderStreamDrop("socket hang up")).toBe(true);
    expect(isRecoverableProviderStreamDrop("read ECONNRESET")).toBe(true);
  });

  it("treats pi-ai early stream end as recoverable", () => {
    expect(
      isRecoverableProviderStreamDrop(
        "STREAM_ENDED_EARLY: provider closed the stream without a done/error event",
      ),
    ).toBe(true);
  });

  it("treats timeout strings as recoverable", () => {
    expect(isRecoverableProviderStreamDrop("Connect Timeout Error")).toBe(true);
    expect(isRecoverableProviderStreamDrop("Request timed out")).toBe(true);
  });

  it("does not treat user stop as recoverable", () => {
    expect(isRecoverableProviderStreamDrop(STREAM_STOPPED_BY_USER_REASON)).toBe(
      false,
    );
    expect(isExpectedStreamCancellation(STREAM_STOPPED_BY_USER_REASON)).toBe(
      true,
    );
  });

  it("does not treat auth errors as recoverable", () => {
    expect(isRecoverableProviderStreamDrop("Invalid API key")).toBe(false);
    expect(isRecoverableProviderStreamDrop("authentication_error")).toBe(false);
  });
});
