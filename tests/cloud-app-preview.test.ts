import { describe, expect, it } from "vitest";
import {
  buildDefaultCloudAppDescription,
  humanizeCloudAppSlug,
  parseCloudAppMetadataFile,
} from "../src/core/utils/cloudAppMetadata.js";
import {
  buildPreviewHeadTags,
  buildPreviewLandingHtml,
  buildPreviewMetaFromSlug,
  CLOUD_APP_LOGIN_BUTTON_LABEL,
  CLOUD_APP_SIGNUP_BUTTON_LABEL,
  CLOUD_APP_SIGN_IN_HEADLINE,
  injectPreviewHeadTags,
  isLinkPreviewCrawler,
} from "../src/core/utils/cloudAppPreview.js";

describe("cloudAppMetadata", () => {
  it("humanizes slugs", () => {
    expect(humanizeCloudAppSlug("paprwork-architecture-navigator")).toBe(
      "Paprwork Architecture Navigator",
    );
  });

  it("builds default descriptions", () => {
    expect(buildDefaultCloudAppDescription("Daily Brief")).toContain("Daily Brief");
    expect(buildDefaultCloudAppDescription("Daily Brief")).toContain("Papr Work");
  });

  it("parses metadata.json", () => {
    const parsed = parseCloudAppMetadataFile(
      JSON.stringify({
        appId: "abc",
        title: "My App",
        description: "Does things",
      }),
    );
    expect(parsed?.title).toBe("My App");
    expect(parsed?.description).toBe("Does things");
  });
});

describe("cloudAppPreview", () => {
  it("detects link preview crawlers", () => {
    expect(isLinkPreviewCrawler("Slackbot-LinkExpanding 1.0")).toBe(true);
    expect(isLinkPreviewCrawler("Mozilla/5.0 Chrome/120")).toBe(false);
  });

  it("builds OG tags", () => {
    const meta = buildPreviewMetaFromSlug(
      "my-dashboard",
      "https://apps.papr.ai/ns/my-dashboard/",
      "https://apps.papr.ai/ns/my-dashboard/opengraph-icon",
      "https://apps.papr.ai/ns/my-dashboard/opengraph-icon",
    );
    const tags = buildPreviewHeadTags(meta);
    expect(tags).toContain('property="og:title"');
    expect(tags).toContain("My Dashboard");
    expect(tags).toContain('property="og:site_name"');
    expect(tags).toContain("Papr Work");
    expect(tags).toContain('property="og:image"');
  });

  it("injects preview tags into html head", () => {
    const html = injectPreviewHeadTags(
      "<html><head><title>Old</title></head></html>",
      "<meta property=\"og:title\" content=\"New Title\">",
    );
    expect(html).toContain('content="New Title"');
  });

  it("builds centered sign-in gate landing with app branding", () => {
    const meta = buildPreviewMetaFromSlug(
      "talent-assessment",
      "https://apps.papr.ai/ns/talent-assessment/",
      "https://apps.papr.ai/ns/talent-assessment/opengraph-icon",
      "https://apps.papr.ai/ns/talent-assessment/opengraph-icon",
    );
    const html = buildPreviewLandingHtml(meta, "", {
      loginUrl: "/auth/login?returnTo=%2F",
      signupUrl: "/auth/login?returnTo=%2F&mode=signup",
      headline: CLOUD_APP_SIGN_IN_HEADLINE,
      iconSvg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
    });
    expect(html).toContain('class="app-brand"');
    expect(html).toContain('class="app-description"');
    expect(html).toContain(CLOUD_APP_SIGN_IN_HEADLINE);
    expect(html).toContain(CLOUD_APP_LOGIN_BUTTON_LABEL);
    expect(html).toContain(CLOUD_APP_SIGNUP_BUTTON_LABEL);
    expect(html).toContain("mode=signup");
    expect(html).toContain("font-style: italic");
  });
});
