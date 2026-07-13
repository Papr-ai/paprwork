import { describe, expect, it } from "vitest";
import {
  buildDefaultCloudAppDescription,
  humanizeCloudAppSlug,
  parseCloudAppMetadataFile,
} from "../src/core/utils/cloudAppMetadata.js";
import {
  buildPreviewHeadTags,
  buildPreviewMetaFromSlug,
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
});
