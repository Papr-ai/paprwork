import { describe, expect, it } from "vitest";
import { inThisOrg } from "./noticeCloudSync.js";

describe("inThisOrg (notices are per org)", () => {
  it("keeps this org's notices and older rows with no org", () => {
    expect(inThisOrg({ orgId: "A" }, "A")).toBe(true);
    expect(inThisOrg({}, "A")).toBe(true);
    expect(inThisOrg({ orgId: null }, "A")).toBe(true);
  });
  it("drops another org's notices", () => {
    expect(inThisOrg({ orgId: "B" }, "A")).toBe(false);
  });
  it("keeps everything when the workspace org is unknown", () => {
    expect(inThisOrg({ orgId: "B" }, undefined)).toBe(true);
  });
});
