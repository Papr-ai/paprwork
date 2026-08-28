import { describe, expect, it } from "vitest";
import {
  buildLocalMiniAppPreviewUrl,
  resolvePublishedWebUrlForPreview,
} from "../src/gateway/utils/miniAppPreviewUrl.js";
import type { CloudPublishConfig } from "../src/gateway/services/CloudAppPublishService.js";
import type { CloudPublishAppPrefs } from "../src/gateway/services/cloudPublishPrefs.js";

describe("buildLocalMiniAppPreviewUrl", () => {
  it("builds gateway local app URL", () => {
    expect(
      buildLocalMiniAppPreviewUrl("http://localhost:18789", "app-abc"),
    ).toBe("http://localhost:18789/apps/app-abc/index.html");
  });
});

describe("resolvePublishedWebUrlForPreview", () => {
  const baseConfig: CloudPublishConfig = {
    appId: "app-1",
    slug: "my-app",
    accessMode: "team",
    loginAccess: "team",
    externalLink: "off",
    enabled: true,
    shareUrl: "https://apps.papr.ai/ns-work/my-app/",
    publishedAt: "2026-01-01T00:00:00.000Z",
    shareToken: null,
  };

  const basePrefs: CloudPublishAppPrefs = {
    autoPublish: true,
    accessMode: "team",
    loginAccess: "team",
    externalLink: "off",
  };

  it("returns null when not published", () => {
    expect(
      resolvePublishedWebUrlForPreview(
        { ...baseConfig, enabled: false, shareUrl: null },
        basePrefs,
      ),
    ).toBeNull();
  });

  it("returns share URL for team login access", () => {
    expect(resolvePublishedWebUrlForPreview(baseConfig, basePrefs)).toBe(
      "https://apps.papr.ai/ns-work/my-app/",
    );
  });

  it("appends share token when external link is enabled", () => {
    const url = resolvePublishedWebUrlForPreview(
      { ...baseConfig, shareToken: "tok123", accessMode: "link_read" },
      {
        ...basePrefs,
        externalLink: "read",
        accessMode: "link_read",
      },
    );
    expect(url).toContain("?t=tok123");
  });
});
