import { describe, expect, it, vi } from "vitest";
import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog.js";
import { mergeNamespaceWorkspaceCatalog } from "../src/gateway/services/CommunityCatalogService.js";

vi.mock("../src/gateway/services/cloudPublishPrefs.js", () => ({
  getAppPublishPrefs: vi.fn(() => ({
    loginAccess: "public",
    externalLink: false,
    codeAccess: "off",
  })),
  hasStoredAppPublishPrefs: vi.fn(() => false),
}));

vi.mock("../src/gateway/utils/paprUserId.js", () => ({
  getPaprUserId: vi.fn(() => "user-amir"),
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
        isOwned: true,
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

  it("does not mark teammate team apps as owned when publisherUserId differs", () => {
    const entries = mergeNamespaceWorkspaceCatalog({
      workspaceRemote: [
        {
          appId: "teammate-app",
          namespaceId: "ns-1",
          name: "Teammate App",
          author: "Shawkat Kabbara",
          visibility: "team",
          publisherUserId: "user-shawkat",
        },
        {
          appId: "my-app",
          namespaceId: "ns-1",
          name: "My App",
          author: "Amir Kabbara",
          visibility: "team",
          publisherUserId: "user-amir",
        },
      ],
      localTeamEntries: [],
      paprDir: "/tmp/papr",
      namespaceId: "ns-1",
      ownedAppIds: new Set(["teammate-app", "my-app"]),
    });

    expect(entries.find((entry) => entry.appId === "teammate-app")?.isOwned).toBe(
      false,
    );
    expect(entries.find((entry) => entry.appId === "my-app")?.isOwned).toBe(true);
  });

  it("defaults codeInstallable to true when memory omits ACL fields (web parity)", () => {
    const entries = mergeNamespaceWorkspaceCatalog({
      workspaceRemote: [
        {
          appId: "teammate-app",
          namespaceId: "ns-1",
          name: "Teammate App",
          visibility: "team",
        },
      ],
      localTeamEntries: [],
      paprDir: "/tmp/papr",
      namespaceId: "ns-1",
      ownedAppIds: new Set(["teammate-app"]),
    });

    expect(
      entries.find((entry) => entry.appId === "teammate-app")?.codeInstallable,
    ).toBe(true);
  });

  it("honors explicit codeInstallable false from memory", () => {
    const entries = mergeNamespaceWorkspaceCatalog({
      workspaceRemote: [
        {
          appId: "live-only",
          namespaceId: "ns-1",
          name: "Live Only",
          visibility: "team",
          codeInstallable: false,
        },
      ],
      localTeamEntries: [],
      paprDir: "/tmp/papr",
      namespaceId: "ns-1",
      ownedAppIds: new Set(),
    });

    expect(
      entries.find((entry) => entry.appId === "live-only")?.codeInstallable,
    ).toBe(false);
  });

  it("prefers the real team publish over a stale e2e test catalog row for the same appId", () => {
    const entries = mergeNamespaceWorkspaceCatalog({
      workspaceRemote: [
        {
          appId: "shared-app",
          namespaceId: "ns-1",
          slug: "e2e-perf-mt391l5a",
          name: null,
          author: "Dale",
          visibility: "team",
          publisherUserId: "user-dale",
          codeAccess: "off",
        },
        {
          appId: "shared-app",
          namespaceId: "ns-1",
          slug: "talent-assessment-1",
          name: "Talent Assessment_1",
          author: "Amir Kabbara",
          visibility: "team",
          publisherUserId: "user-amir",
          codeAccess: "install",
        },
      ],
      localTeamEntries: [],
      paprDir: "/tmp/papr",
      namespaceId: "ns-1",
      ownedAppIds: new Set(["shared-app"]),
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.slug).toBe("talent-assessment-1");
    expect(entries[0]?.name).toBe("Talent Assessment_1");
    expect(entries[0]?.isOwned).toBe(true);
  });
});
