import { describe, expect, it } from "vitest";
import { linkedCopyPublishSlug, personalSlugHandle, publishSlugRetryCandidates } from "./uniqueAppNaming.js";

describe("linked copy publish slug", () => {
  it("never takes the original's link; uses the publisher's first name", () => {
    expect(linkedCopyPublishSlug("linkedin-outreach", "linkedin-outreach", "shawkat")).toBe("linkedin-outreach-shawkat");
  });
  it("leaves other slugs alone (already published copy, or not a copy)", () => {
    expect(linkedCopyPublishSlug("linkedin-outreach-shawkat", "linkedin-outreach", "shawkat")).toBe("linkedin-outreach-shawkat");
    expect(linkedCopyPublishSlug("scenario", undefined, "shawkat")).toBe("scenario");
  });
  it("falls back to -copy without a name", () => {
    expect(linkedCopyPublishSlug("linkedin-outreach", "linkedin-outreach", undefined)).toBe("linkedin-outreach-copy");
  });
  it("derives a handle from name, then email", () => {
    expect(personalSlugHandle({ name: "Shawkat Kabbara" })).toBe("shawkat");
    expect(personalSlugHandle({ email: "amir.k@papr.ai" })).toBe("amir-k");
    expect(personalSlugHandle({})).toBeUndefined();
  });
  it("retries end with a random suffix so the name alone never fails a publish", () => {
    expect(publishSlugRetryCandidates("app", 3, () => "x1y2z3")).toEqual(["app", "app-1", "app-2", "app-x1y2z3"]);
  });
});
