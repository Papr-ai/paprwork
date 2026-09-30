import { describe, expect, test } from "vitest";

import type { CommunityCatalogEntry } from "../../../src/core/types/communityCatalog";
import {
  resolveCatalogLiveWebUrl,
  resolveCatalogPreviewIframeUrl,
} from "../../utils/catalogPreviewUrl";

function cloudEntry(
  overrides: Partial<CommunityCatalogEntry> = {},
): CommunityCatalogEntry {
  return {
    catalogId: "cloud:app-1",
    source: "cloud",
    name: "Demo",
    description: "",
    version: "cloud",
    author: "Author",
    tags: [],
    appId: "11111111-1111-4111-8111-111111111111",
    namespaceId: "ns-work",
    slug: "demo-app",
    codeInstallable: true,
    liveViewable: true,
    liveUrl: "https://apps.papr.ai/ns-work/demo-app/",
    ...overrides,
  };
}

describe("resolveCatalogPreviewIframeUrl", () => {
  test("proxies liveUrl through gateway cloud-preview", () => {
    const url = resolveCatalogPreviewIframeUrl(cloudEntry());
    expect(url).toContain("/cloud-preview/ns-work/demo-app");
  });

  test("builds from namespace + slug when liveUrl missing", () => {
    const url = resolveCatalogPreviewIframeUrl(
      cloudEntry({ liveUrl: null }),
    );
    expect(url).toContain("/cloud-preview/ns-work/demo-app");
  });

  test("returns null without preview targets", () => {
    expect(
      resolveCatalogPreviewIframeUrl(
        cloudEntry({ liveUrl: null, namespaceId: undefined, slug: null }),
      ),
    ).toBeNull();
  });
});

describe("resolveCatalogLiveWebUrl", () => {
  test("prefers entry liveUrl", () => {
    expect(resolveCatalogLiveWebUrl(cloudEntry())).toBe(
      "https://apps.papr.ai/ns-work/demo-app/",
    );
  });
});
