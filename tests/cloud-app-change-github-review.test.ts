import { describe, expect, it } from "vitest";
import { parsePullNumberFromPrUrl } from "../src/gateway/services/cloudAppChangeGitHubReview.js";

describe("parsePullNumberFromPrUrl", () => {
  it("parses standard GitHub pull URLs", () => {
    expect(
      parsePullNumberFromPrUrl(
        "https://github.com/papr-ai/papr-work-app-abc/pull/42",
      ),
    ).toBe(42);
  });

  it("returns null for empty or non-pull URLs", () => {
    expect(parsePullNumberFromPrUrl(null)).toBeNull();
    expect(parsePullNumberFromPrUrl("https://github.com/o/r/compare/main...x")).toBeNull();
  });
});
