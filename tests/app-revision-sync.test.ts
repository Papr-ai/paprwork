import { afterEach, describe, expect, it } from "vitest";
import {
  invalidateRepoCacheForPublishedApp,
  resetCloudAppHostCachesForTests,
} from "../src/gateway/services/appRuntime/cloudAppHostCache.js";
import {
  parsePublishedAppRoute,
  resolvePublishRouteForNotify,
} from "../src/gateway/services/cloudSync/notifyCloudAppRevision.js";

describe("parsePublishedAppRoute", () => {
  it("parses namespace and slug from share URL", () => {
    expect(
      parsePublishedAppRoute("https://apps.papr.ai/vVpht1wnRb/audit-workbench/"),
    ).toEqual({
      namespaceId: "vVpht1wnRb",
      slug: "audit-workbench",
    });
  });

  it("returns null for invalid URLs", () => {
    expect(parsePublishedAppRoute(null)).toBeNull();
    expect(parsePublishedAppRoute("https://apps.papr.ai/")).toBeNull();
  });
});

describe("resolvePublishRouteForNotify", () => {
  it("prefers share URL over slug fallback", () => {
    expect(
      resolvePublishRouteForNotify({
        shareUrl: "https://apps.papr.ai/ns-a/my-app/",
        slug: "other-slug",
        namespaceId: "ns-b",
      }),
    ).toEqual({ namespaceId: "ns-a", slug: "my-app" });
  });

  it("falls back to slug and active namespace", () => {
    expect(
      resolvePublishRouteForNotify({
        shareUrl: null,
        slug: "lead-prospector",
        namespaceId: "85ZIB7mD1V",
      }),
    ).toEqual({ namespaceId: "85ZIB7mD1V", slug: "lead-prospector" });
  });
});

describe("invalidateRepoCacheForPublishedApp", () => {
  afterEach(() => {
    resetCloudAppHostCachesForTests();
  });

  it("is safe to call when no cache entries exist", () => {
    expect(() =>
      invalidateRepoCacheForPublishedApp("ns-1", "my-app"),
    ).not.toThrow();
  });
});
