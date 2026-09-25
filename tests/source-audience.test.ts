import { describe, expect, it } from "vitest";
import { resolveSourceAudience } from "../src/gateway/services/runCloudCatalogInstall.js";

describe("resolveSourceAudience", () => {
  it("team visibility is a team app", () => {
    expect(resolveSourceAudience({ visibility: "team" })).toBe("team");
  });
  it("listed public app is Community", () => {
    expect(resolveSourceAudience({ visibility: "public_read" })).toBe("community");
  });
  it("public_read but not listed is a specific-people share", () => {
    expect(
      resolveSourceAudience({ visibility: "public_read", communityCatalogListed: false }),
    ).toBe("people");
  });
  it("invite links and unknown give no mark", () => {
    expect(resolveSourceAudience({ visibility: "link_read" })).toBeUndefined();
    expect(resolveSourceAudience({})).toBeUndefined();
  });
});
