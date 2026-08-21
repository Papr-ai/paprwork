import { describe, expect, it } from "vitest";
import {
  audienceModelNeedsInitialCodeUpload,
  isCloudAppLive,
  sharingChangeIsAclOnly,
} from "../src/core/utils/cloudPublishRouting.js";
import { isCloudCatalogLightSyncEnabled } from "../src/core/types/cloudPublishIntent.js";

describe("cloudPublishRouting", () => {
  describe("isCloudAppLive", () => {
    it("returns true when enabled with share URL", () => {
      expect(
        isCloudAppLive({ enabled: true, shareUrl: "https://apps.papr.ai/ns/app" }),
      ).toBe(true);
    });

    it("returns false when disabled or missing share URL", () => {
      expect(isCloudAppLive({ enabled: false, shareUrl: "https://x" })).toBe(
        false,
      );
      expect(isCloudAppLive({ enabled: true, shareUrl: null })).toBe(false);
      expect(isCloudAppLive(null)).toBe(false);
    });
  });

  describe("sharingChangeIsAclOnly", () => {
    it("is ACL-only for live apps", () => {
      expect(sharingChangeIsAclOnly(true)).toBe(true);
    });

    it("requires register flow when not live", () => {
      expect(sharingChangeIsAclOnly(false)).toBe(false);
    });
  });

  describe("audienceModelNeedsInitialCodeUpload", () => {
    it("skips upload for live apps", () => {
      expect(
        audienceModelNeedsInitialCodeUpload(
          { audience: "private", permission: "read" },
          true,
        ),
      ).toBe(false);
    });

    it("skips upload for desktop-only private install before first publish", () => {
      expect(
        audienceModelNeedsInitialCodeUpload(
          { audience: "private", permission: "edit" },
          false,
        ),
      ).toBe(false);
    });

    it("requires upload for web-hosted audiences before first publish", () => {
      expect(
        audienceModelNeedsInitialCodeUpload(
          { audience: "private", permission: "read" },
          false,
        ),
      ).toBe(true);
      expect(
        audienceModelNeedsInitialCodeUpload(
          { audience: "team", permission: "write" },
          false,
        ),
      ).toBe(true);
    });
  });

  describe("isCloudCatalogLightSyncEnabled", () => {
    it("is always enabled (no env var required)", () => {
      expect(isCloudCatalogLightSyncEnabled()).toBe(true);
    });
  });
});
