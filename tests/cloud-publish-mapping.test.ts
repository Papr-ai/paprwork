import { describe, expect, it } from "vitest";
import {
  accessModeToPublishFields,
  memoryPublishResponseToConfig,
  visibilityToAccessMode,
} from "../src/gateway/services/cloudPublishMapping.js";
import {
  cloudContextCookieHeaders,
  isReservedCloudPathSegment,
  resolveCloudRouteContext,
} from "../src/gateway/services/appRuntime/cloudAppHostContext.js";

describe("cloudPublishMapping", () => {
  it("maps accessMode to memory visibility + linkPermission", () => {
    expect(accessModeToPublishFields("private")).toEqual({
      visibility: "private",
      linkPermission: "read_write",
      shareLinkEnabled: false,
    });
    expect(accessModeToPublishFields("link_read_write")).toEqual({
      visibility: "link_read_write",
      linkPermission: "read_write",
      shareLinkEnabled: true,
    });
    expect(accessModeToPublishFields("public_read")).toEqual({
      visibility: "public_read",
      linkPermission: "read_write",
      shareLinkEnabled: false,
    });
  });

  it("parses memory visibility into accessMode", () => {
    expect(visibilityToAccessMode("team")).toBe("team");
    expect(visibilityToAccessMode("unknown")).toBe("private");
  });

  it("converts memory publish response to CloudPublishConfig shape", () => {
    const config = memoryPublishResponseToConfig("app-1", {
      appId: "app-1",
      slug: "my-app",
      visibility: "link_read",
      shareUrl: "https://apps.papr.ai/ns/my-app",
      enabled: true,
      shareToken: "tok",
    });
    expect(config.accessMode).toBe("link_read");
    expect(config.enabled).toBe(true);
    expect(config.shareToken).toBe("tok");
    expect(config.shareUrl).toBe("https://apps.papr.ai/ns/my-app/?t=tok");
  });
});

describe("cloudAppHostContext", () => {
  it("rejects reserved path segments", () => {
    expect(isReservedCloudPathSegment("api")).toBe(true);
    expect(isReservedCloudPathSegment("ns-123")).toBe(false);
  });

  it("resolves namespace + slug from params, query, cookies, headers", () => {
    expect(
      resolveCloudRouteContext({
        params: { namespaceId: "ns-1", slug: "dashboard" },
      }),
    ).toEqual({ namespaceId: "ns-1", slug: "dashboard" });

    expect(
      resolveCloudRouteContext({
        query: { namespaceId: "ns-2", slug: "reports" },
      }),
    ).toEqual({ namespaceId: "ns-2", slug: "reports" });

    expect(
      resolveCloudRouteContext({
        cookieHeader: "papr_cloud_ns=ns-3; papr_cloud_slug=weekly-war-room",
      }),
    ).toEqual({ namespaceId: "ns-3", slug: "weekly-war-room" });

    expect(
      resolveCloudRouteContext({
        headers: {
          "x-papr-namespace-id": "ns-4",
          "x-papr-slug": "audit",
        },
      }),
    ).toEqual({ namespaceId: "ns-4", slug: "audit" });
  });

  it("builds cloud context cookie headers", () => {
    const cookies = cloudContextCookieHeaders("ns-1", "my-app", false);
    expect(cookies[0]).toContain("papr_cloud_ns=ns-1");
    expect(cookies[1]).toContain("papr_cloud_slug=my-app");
  });
});
