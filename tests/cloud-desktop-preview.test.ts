import { describe, expect, it } from "vitest";
import { isCloudShareGateHtml } from "../src/gateway/services/appRuntime/cloudPreviewRuntimeAuth.js";
import {
  buildUpstreamCloudPreviewUrl,
  buildUpstreamPublishedWebUrl,
  parsePublishedAppUrl,
} from "../ui/utils/cloudDesktopPreview.js";

describe("isCloudShareGateHtml", () => {
  it("detects team sign-in gate HTML", () => {
    const html = `<!DOCTYPE html><html><body><main><p class="gate-status">Sign in is required to access this app.</p></main></body></html>`;
    expect(isCloudShareGateHtml(html)).toBe(true);
  });

  it("returns false for normal mini-app HTML", () => {
    expect(isCloudShareGateHtml("<html><body><div id=\"root\"></div></body></html>")).toBe(
      false,
    );
  });
});

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
