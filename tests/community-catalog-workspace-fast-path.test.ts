import { describe, expect, it, vi } from "vitest";
import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog.js";
import { mergeNamespaceWorkspaceCatalog } from "../src/gateway/services/CommunityCatalogService.js";

vi.mock("../src/gateway/services/cloudPublishPrefs.js", () => ({
  getAppPublishPrefs: vi.fn(() => ({
    loginAccess: "public",
    externalLink: false,
    codeAccess: "off",
  })),
}));

describe("mergeNamespaceWorkspaceCatalog", () => {
  it("uses workspace rows as primary catalog and adds local-only team apps", () => {
    const localTeam: CommunityCatalogEntry[] = [
      {
        catalogId: "cloud:local-only",
        source: "cloud",
        name: "Local Team",
        description: "",
        version: "cloud",
        author: "You",
        tags: ["team"],
        appId: "local-only",
        namespaceId: "ns-1",
        visibility: "team",
        codeInstallable: false,
        liveViewable: true,
      },
    ];

    const entries = mergeNamespaceWorkspaceCatalog({
      workspaceRemote: [
        {
          appId: "remote-team",
          namespaceId: "ns-1",
          name: "Remote Team",
          visibility: "team",
        },
        {
          appId: "remote-public",
          namespaceId: "ns-1",
          name: "Remote Public",
          visibility: "public_read",
        },
      ],
      localTeamEntries: localTeam,
      paprDir: "/tmp/papr",
      namespaceId: "ns-1",
      ownedAppIds: new Set(["local-only"]),
    });

    const ids = entries.map((entry) => entry.appId).sort();
    expect(ids).toEqual(["local-only", "remote-public", "remote-team"]);
    expect(entries.find((entry) => entry.appId === "local-only")?.isOwned).toBe(
      true,
    );
  });
});
