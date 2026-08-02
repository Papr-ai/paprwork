import { describe, expect, it } from "vitest";
import {
  buildDesktopCloudPreviewUrl,
  getCloudPreviewContextForApi,
  parsePublishedAppUrl,
} from "../src/gateway/services/appRuntime/cloudDesktopPreviewProxy.js";

function mockRequest(referer?: string): Parameters<typeof getCloudPreviewContextForApi>[0] {
  return {
    headers: { referer },
  } as Parameters<typeof getCloudPreviewContextForApi>[0];
}

describe("cloudDesktopPreviewProxy", () => {
  it("parses published app URLs", () => {
    expect(
      parsePublishedAppUrl(
        "https://apps.papr.ai/VIA2C5VDxj/myadvice-meetings-2/",
      ),
    ).toEqual({
      namespaceId: "VIA2C5VDxj",
      slug: "myadvice-meetings-2",
      shareToken: undefined,
    });
  });

  it("parses invite token from published URL", () => {
    expect(
      parsePublishedAppUrl(
        "https://apps.papr.ai/abc/slug/?t=share-token-123",
      )?.shareToken,
    ).toBe("share-token-123");
  });

  it("builds gateway preview URL", () => {
    expect(
      buildDesktopCloudPreviewUrl(
        "http://localhost:18789",
        "https://apps.papr.ai/ns/slug/",
      ),
    ).toBe("http://localhost:18789/cloud-preview/ns/slug/");
  });

  it("routes API proxy only from cloud-preview referer", () => {
    expect(
      getCloudPreviewContextForApi(
        mockRequest("http://localhost:18789/cloud-preview/ns/slug/index.html"),
      ),
    ).toEqual({ namespaceId: "ns", slug: "slug" });
    expect(
      getCloudPreviewContextForApi(
        mockRequest("http://localhost:18789/apps/uuid/index.html"),
      ),
    ).toBeNull();
    expect(getCloudPreviewContextForApi(mockRequest())).toBeNull();
  });
});
