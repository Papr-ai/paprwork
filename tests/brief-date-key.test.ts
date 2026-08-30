import { describe, expect, it } from "vitest";
import {
  formatBriefDateKey,
  todayBriefDateKey,
} from "../src/core/utils/briefDateKey.js";

describe("briefDateKey", () => {
  it("formatBriefDateKey uses local calendar parts", () => {
    const key = formatBriefDateKey(new Date("2026-08-29T23:30:00-07:00"));
    expect(key).toBe("2026-08-29");
  });

  it("formatBriefDateKey respects IANA timezone", () => {
    const key = formatBriefDateKey(
      new Date("2026-08-30T02:30:00Z"),
      "America/Los_Angeles",
    );
    expect(key).toBe("2026-08-29");
  });

  it("todayBriefDateKey returns YYYY-MM-DD", () => {
    expect(todayBriefDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
