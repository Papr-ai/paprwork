import { describe, expect, it } from "vitest";
import { codeAccessPatchFromMemory } from "../src/gateway/services/cloudPublishDrift.js";

const live = (codeAccess?: "off" | "install") =>
  ({ enabled: true, codeAccess }) as never;

describe("Edit the code follows the cloud, not stale local prefs", () => {
  it("adopts install when local prefs are missing it", () => {
    expect(codeAccessPatchFromMemory({}, live("install"))).toEqual({ codeAccess: "install" });
  });
  it("adopts install over a stale local off", () => {
    expect(codeAccessPatchFromMemory({ codeAccess: "off" }, live("install"))).toEqual({
      codeAccess: "install",
    });
  });
  it("no change when they agree", () => {
    expect(codeAccessPatchFromMemory({ codeAccess: "install" }, live("install"))).toBeNull();
  });
  it("ignores unpublished apps and missing cloud values", () => {
    expect(codeAccessPatchFromMemory({ codeAccess: "install" }, null)).toBeNull();
    expect(codeAccessPatchFromMemory({ codeAccess: "install" }, live(undefined))).toBeNull();
  });
});
