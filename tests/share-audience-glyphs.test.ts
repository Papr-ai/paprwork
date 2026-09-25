import { describe, expect, it } from "vitest";
import {
  loginAccessToShareAudience,
  shareAudienceGlyphPath,
  shareAudienceShortLabel,
} from "../ui/utils/shareAudienceGlyphs.js";

describe("shareAudienceGlyphs", () => {
  it("uses distinct paths for public vs people", () => {
    expect(shareAudienceGlyphPath("public")).not.toBe(
      shareAudienceGlyphPath("people"),
    );
  });

  it("maps loginAccess public without overriding people label when audience is explicit", () => {
    expect(loginAccessToShareAudience("public")).toBe("public");
    expect(shareAudienceShortLabel("people")).toBe("Specific people");
  });
});
