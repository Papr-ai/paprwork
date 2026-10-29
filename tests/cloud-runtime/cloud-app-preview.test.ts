import { describe, expect, it } from "vitest";
import {
  buildDefaultCloudAppDescription,
  humanizeCloudAppSlug,
  parseCloudAppMetadataFile,
} from "../../src/core/utils/cloudAppMetadata.js";
import {
  buildPreviewHeadTags,
  buildWebAppManifest,
  buildWebAppManifestUrl,
  shortAppName,
  buildPreviewLandingHtml,
  buildPreviewMetaFromSlug,
  CLOUD_APP_LOGIN_BUTTON_LABEL,
  CLOUD_APP_SIGNUP_BUTTON_LABEL,
  CLOUD_APP_SIGN_IN_HEADLINE,
  injectPreviewHeadTags,
  isLinkPreviewCrawler,
} from "../../src/core/utils/cloudAppPreview.js";

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

  it("links a per-app web manifest so the app is installable", () => {
    const meta = buildPreviewMetaFromSlug(
      "tip-split",
      "https://apps.papr.ai/ns/tip-split/",
      "https://apps.papr.ai/ns/tip-split/opengraph-icon",
      "https://apps.papr.ai/ns/tip-split/opengraph-image",
    );
    const tags = buildPreviewHeadTags(meta);
    expect(tags).toContain('<link rel="manifest" href="https://apps.papr.ai/ns/tip-split/manifest.webmanifest"');
    expect(tags).toContain('name="theme-color"');
  });

  it("builds a manifest scoped to the app root", () => {
    const meta = buildPreviewMetaFromSlug(
      "tip-split",
      "https://apps.papr.ai/ns/tip-split/",
      "https://apps.papr.ai/ns/tip-split/opengraph-icon",
      "https://apps.papr.ai/ns/tip-split/opengraph-image",
    );
    const m = buildWebAppManifest(meta);
    expect(m.scope).toBe("/ns/tip-split/");
    expect(m.start_url).toBe("/ns/tip-split/");
    expect(m.id).toBe("/ns/tip-split/");
    expect(m.display).toBe("standalone");
    expect(m.name).toBe("Tip Split");
    expect(m.icons).toEqual([
      { src: "https://apps.papr.ai/ns/tip-split/opengraph-icon?size=192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "https://apps.papr.ai/ns/tip-split/opengraph-icon", sizes: "512x512", type: "image/png", purpose: "any" },
    ]);
  });

  it("keeps the share token so invite-link visitors can install and reopen", () => {
    const meta = buildPreviewMetaFromSlug(
      "crm",
      "https://apps.papr.ai/ns/crm/",
      "https://apps.papr.ai/ns/crm/opengraph-icon?t=abc%2B1",
      "https://apps.papr.ai/ns/crm/opengraph-image?t=abc%2B1",
    );
    expect(buildWebAppManifestUrl(meta)).toBe("https://apps.papr.ai/ns/crm/manifest.webmanifest?t=abc%2B1");
    expect(buildWebAppManifest(meta).start_url).toBe("/ns/crm/?t=abc%2B1");
    expect(buildWebAppManifest(meta).id).toBe("/ns/crm/");
    expect((buildWebAppManifest(meta).icons as Array<{ src: string }>)[0]!.src).toBe(
      "https://apps.papr.ai/ns/crm/opengraph-icon?t=abc%2B1&size=192",
    );
  });

  it("shortens long titles for the Dock label", () => {
    expect(shortAppName("Tip Split")).toBe("Tip Split");
    expect(shortAppName("Papr Careers · Forward Deployed Engineer")).toBe("Papr Careers");
    expect(shortAppName("Delaware Tax Filing Guide — Papr, Inc.")).toBe("Delaware Tax Filing Guide".slice(0, 23).trimEnd() + "…");
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
    expect(html).toContain('class="gate-status"');
    expect(html).toContain("/discover/_/drop-light.png");
    expect(html).not.toContain("font-style: italic");
  });
});
