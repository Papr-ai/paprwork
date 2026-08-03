import { describe, expect, it } from "vitest";
import {
  buildUpstreamCloudPreviewUrl,
  buildUpstreamPublishedWebUrl,
  parsePublishedAppUrl,
} from "../ui/utils/cloudDesktopPreview.js";

describe("cloudDesktopPreview (track collaborator Web)", () => {
  it("buildUpstreamPublishedWebUrl uses publisher namespace and slug", () => {
    const url = buildUpstreamPublishedWebUrl({
      sourceNamespaceId: "ns-publisher",
      sourceSlug: "gtm-dashboard",
    });
    expect(url).toBe("https://apps.papr.ai/ns-publisher/gtm-dashboard");
  });

  it("buildUpstreamCloudPreviewUrl proxies publisher deployment via gateway", () => {
    const url = buildUpstreamCloudPreviewUrl({
      sourceNamespaceId: "ns-publisher",
      sourceSlug: "gtm-dashboard",
    });
    expect(url).toBe(
      "http://localhost:18789/cloud-preview/ns-publisher/gtm-dashboard/",
    );
  });

  it("parsePublishedAppUrl extracts namespace, slug, and share token", () => {
    const parsed = parsePublishedAppUrl(
      "https://apps.papr.ai/org-ns/my-app?t=secret-token",
    );
    expect(parsed).toEqual({
      namespaceId: "org-ns",
      slug: "my-app",
      shareToken: "secret-token",
    });
  });
});
