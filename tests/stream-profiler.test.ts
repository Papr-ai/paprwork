import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  StreamProfiler,
  finishStreamProfiler,
  getStreamProfiler,
  startStreamProfiler,
} from "../src/core/utils/streamProfiler.js";

describe("StreamProfiler", () => {
  const originalEnv = process.env.PAPR_STREAM_PROFILE;

  beforeEach(() => {
    process.env.PAPR_STREAM_PROFILE = "1";
  });

  afterEach(() => {
    process.env.PAPR_STREAM_PROFILE = originalEnv;
    finishStreamProfiler("test-chat");
  });

  it("records sequential marks", () => {
    const p = new StreamProfiler("test", "unit");
    p.mark("a");
    p.mark("b");
    const gaps = p.getGaps();
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    expect(gaps.some((g) => g.from.includes("a") && g.to.includes("b"))).toBe(
      true,
    );
  });

  it("tracks active profiler by chat id", () => {
    const p = startStreamProfiler("test-chat", "gateway");
    expect(getStreamProfiler("test-chat")).toBe(p);
  });
});
