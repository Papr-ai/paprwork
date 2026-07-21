import { describe, expect, test } from "vitest";
import {
  parseJobProgressLine,
  toJobProgressData,
} from "../src/gateway/utils/parseJobProgressLine.js";

describe("parseJobProgressLine", () => {
  test("parses valid PAPR_PROGRESS line", () => {
    const parsed = parseJobProgressLine(
      'PAPR_PROGRESS {"event":"score_count","payload":{"sourceId":5,"count":12}}',
    );
    expect(parsed).toEqual({
      event: "score_count",
      payload: { sourceId: 5, count: 12 },
    });
  });

  test("returns null for non-progress lines", () => {
    expect(parseJobProgressLine("[INFO] running")).toBeNull();
    expect(parseJobProgressLine("PAPR_PROGRESS not-json")).toBeNull();
  });

  test("toJobProgressData attaches jobId", () => {
    const parsed = parseJobProgressLine(
      'PAPR_PROGRESS {"event":"batch","payload":{"n":3}}',
    );
    expect(parsed).not.toBeNull();
    expect(toJobProgressData("job-1", parsed!)).toEqual({
      jobId: "job-1",
      event: "batch",
      payload: { n: 3 },
    });
  });
});
