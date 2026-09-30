import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  mergeNamespaceWorkspaceCatalog,
  resolveCatalogLiveUrl,
} from "../src/gateway/services/CommunityCatalogService.js";

const getAppPublishPrefs = vi.fn();

vi.mock("../src/gateway/services/cloudPublishPrefs.js", () => ({
  getAppPublishPrefs: (...args: unknown[]) => getAppPublishPrefs(...args),
}));

describe("resolveCatalogLiveUrl", () => {
  beforeEach(() => {
    getAppPublishPrefs.mockReset();
  });

  it("appends share token when memory server marks shareLinkEnabled", () => {
    const url = resolveCatalogLiveUrl({
      shareUrl: "https://apps.papr.ai/ns-1/my-app/",
      shareToken: "secret-token",
      visibility: "team",
      shareLinkEnabled: true,
    });
    expect(url).toBe("https://apps.papr.ai/ns-1/my-app/?t=secret-token");
  });

  it("keeps Papr login URL when external link is off", () => {
    const url = resolveCatalogLiveUrl({
      shareUrl: "https://apps.papr.ai/ns-1/my-app/",
      shareToken: "secret-token",
      visibility: "team",
      shareLinkEnabled: false,
    });
    expect(url).toBe("https://apps.papr.ai/ns-1/my-app/");
  });

  it("uses local prefs token for owned apps when remote row omits it", () => {
    getAppPublishPrefs.mockReturnValue({
      loginAccess: "team",
      externalLink: "read",
      accessMode: "team",
      shareToken: "local-token",
    });

    const url = resolveCatalogLiveUrl({
      shareUrl: "https://apps.papr.ai/ns-1/my-app/",
      visibility: "team",
      shareLinkEnabled: false,
      appId: "app-owned",
      paprDir: "/tmp/papr",
    });
    expect(url).toBe("https://apps.papr.ai/ns-1/my-app/?t=local-token");
  });
});

describe("mergeNamespaceWorkspaceCatalog live URLs", () => {
  beforeEach(() => {
    getAppPublishPrefs.mockReset();
    getAppPublishPrefs.mockReturnValue({
      loginAccess: "team",
      externalLink: "read",
      accessMode: "team",
      shareToken: "local-token",
    });
  });

  it("prefers access link over remote app URL for owned team apps with external link", () => {
    const entries = mergeNamespaceWorkspaceCatalog({
      workspaceRemote: [
        {
          appId: "app-owned",
          namespaceId: "ns-1",
          name: "Owned Team App",
          visibility: "team",
          shareUrl: "https://apps.papr.ai/ns-1/owned-app/",
          shareLinkEnabled: false,
        },
      ],
      localTeamEntries: [],
      paprDir: "/tmp/papr",
      namespaceId: "ns-1",
      ownedAppIds: new Set(["app-owned"]),
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.liveUrl).toBe(
      "https://apps.papr.ai/ns-1/owned-app/?t=local-token",
    );
  });
});
