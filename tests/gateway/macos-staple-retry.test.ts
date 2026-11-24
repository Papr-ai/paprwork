import { describe, expect, it } from "vitest";
import {
  findStapleTargets,
  isStapleFailureOutput,
} from "../../scripts/macos-staple-retry.mjs";

describe("isStapleFailureOutput", () => {
  it("detects typical electron-builder staple failure on Intel CI", () => {
    const log = `
      Failed to staple and validate action failed
      Error 68
      NSURLErrorDomain Code=-1005
      api.apple-cloudkit.com
    `;
    expect(isStapleFailureOutput(log)).toBe(true);
  });

  it("returns false for unrelated build failures", () => {
    expect(isStapleFailureOutput("codesign: resource fork not allowed")).toBe(false);
    expect(isStapleFailureOutput("")).toBe(false);
  });
});

describe("findStapleTargets", () => {
  it("returns empty when release dir is missing", () => {
    expect(findStapleTargets("/nonexistent-release-dir-xyz")).toEqual([]);
  });
});
