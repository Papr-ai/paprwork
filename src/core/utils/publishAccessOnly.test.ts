import { describe, expect, it } from "vitest";

import { isAccessOnlyRequest } from "./publishAccessOnly.js";

describe("isAccessOnlyRequest", () => {
  it("is true for sharing-only changes", () => {
    expect(isAccessOnlyRequest({ loginAccess: "private" })).toBe(true);
    expect(isAccessOnlyRequest({ externalLink: "off", requireSignIn: true })).toBe(true);
    expect(isAccessOnlyRequest({ uploadMaxMb: 100 })).toBe(true);
    expect(isAccessOnlyRequest({ loginAccess: "team", unpublish: false })).toBe(true);
  });

  it("is false when nothing about access changes", () => {
    expect(isAccessOnlyRequest({})).toBe(false);
  });

  it("is false when the request also needs a code publish", () => {
    expect(isAccessOnlyRequest({ loginAccess: "public", codeAccess: "install" })).toBe(false);
    expect(isAccessOnlyRequest({ loginAccess: "team", perUserIsolation: true })).toBe(false);
    expect(isAccessOnlyRequest({ loginAccess: "private", unpublish: true })).toBe(false);
  });
});
