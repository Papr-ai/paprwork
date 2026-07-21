import { describe, expect, it } from "vitest";
import { parseAppIdFromEditFilePath } from "../ui/utils/parseEditFileAppId";

describe("parseAppIdFromEditFilePath", () => {
  it("parses app id from Papr apps path", () => {
    expect(
      parseAppIdFromEditFilePath("~/Papr/apps/abc-123/index.html"),
    ).toBe("abc-123");
    expect(
      parseAppIdFromEditFilePath("/Users/me/Papr/apps/abc-123/app.ts"),
    ).toBe("abc-123");
  });

  it("returns undefined for non-app paths", () => {
    expect(
      parseAppIdFromEditFilePath("~/Documents/GitHub/paprwork-v2/foo.ts"),
    ).toBeUndefined();
  });
});
