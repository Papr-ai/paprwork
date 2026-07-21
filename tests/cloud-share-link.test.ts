import { describe, expect, it } from "vitest";
import {
  accessModeRequiresShareToken,
  formatShareLink,
} from "../src/core/utils/cloudShareLink.js";

describe("cloudShareLink", () => {
  it("appends token query param for link modes", () => {
    expect(
      formatShareLink(
        "https://apps.papr.ai/ns/my-app",
        "secret-token",
        "link_read",
      ),
    ).toBe("https://apps.papr.ai/ns/my-app/?t=secret-token");
  });

  it("normalizes app root URLs with trailing slash", () => {
    expect(
      formatShareLink(
        "https://apps.papr.ai/ns/my-app/",
        null,
        "public_read",
      ),
    ).toBe("https://apps.papr.ai/ns/my-app/");
  });

  it("leaves private/team URLs unchanged", () => {
    expect(
      formatShareLink(
        "https://apps.papr.ai/ns/my-app",
        "secret-token",
        "private",
      ),
    ).toBe("https://apps.papr.ai/ns/my-app/");
  });

  it("detects link modes", () => {
    expect(accessModeRequiresShareToken("link_read")).toBe(true);
    expect(accessModeRequiresShareToken("team")).toBe(false);
  });
});
