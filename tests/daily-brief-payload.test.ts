import { describe, expect, it } from "vitest";
import {
  isBriefDateKey,
  parseDailyBriefPayload,
  validateDailyBriefWrite,
} from "../src/core/utils/dailyBriefPayload.js";

describe("dailyBriefPayload", () => {
  it("accepts ISO date keys only", () => {
    expect(isBriefDateKey("2026-09-02")).toBe(true);
    expect(isBriefDateKey("2026-09-02-test")).toBe(false);
    expect(isBriefDateKey("")).toBe(false);
  });

  it("rejects empty or partial brief JSON", () => {
    expect(parseDailyBriefPayload("{}")).toBeNull();
    expect(parseDailyBriefPayload('{"sections":[]}')).toBeNull();
    expect(parseDailyBriefPayload('{"hero":{"title":"Hi"},"sections":[]}')).toBeNull();
    expect(
      parseDailyBriefPayload(
        '{"hero":{"title":"Hi"},"sections":[{"type":"alerts","items":[]}]}',
      ),
    ).not.toBeNull();
  });

  it("validateDailyBriefWrite blocks test rows", () => {
    const bad = validateDailyBriefWrite("2026-09-02-test", "{}");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain("YYYY-MM-DD");
    }

    const good = validateDailyBriefWrite(
      "2026-09-02",
      '{"hero":{"title":"Daily Brief"},"sections":[{"type":"freeform","content":"x"}]}',
    );
    expect(good.ok).toBe(true);
  });
});
