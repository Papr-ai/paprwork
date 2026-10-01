import { describe, expect, it } from "vitest";
import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog.js";
import {
  buildAgentCommunityAppListings,
  filterCustomizableCatalogEntries,
  matchesCommunityCatalogQuery,
} from "../src/gateway/services/communityCatalogAgentBrowse.js";

function entry(
  overrides: Partial<CommunityCatalogEntry> = {},
): CommunityCatalogEntry {
  return {
    catalogId: "cloud:app-1",
    source: "cloud",
    name: "Demo App",
    description: "A forkable demo",
    version: "cloud",
    author: "Author",
    tags: ["dashboard"],
    appId: "app-1",
    namespaceId: "ns-1",
    slug: "demo-app",
    codeInstallable: true,
    liveViewable: true,
    ...overrides,
  };
}

describe("communityCatalogAgentBrowse", () => {
  it("keeps only codeInstallable cloud apps for community scope", () => {
    const filtered = filterCustomizableCatalogEntries(
      [
        entry({ name: "Forkable" }),
        entry({
          catalogId: "cloud:preview",
          appId: "preview",
          name: "Preview only",
          codeInstallable: false,
        }),
      ],
      "global",
    );
    expect(filtered.map((item) => item.name)).toEqual(["Forkable"]);
  });

  it("drops opensource entries from team scope", () => {
    const filtered = filterCustomizableCatalogEntries(
      [
        entry({ name: "Team cloud" }),
        {
          ...entry({
            catalogId: "oss:bundle",
            source: "opensource",
            bundleId: "bundle-1",
            name: "OSS bundle",
          }),
        },
      ],
      "namespace",
    );
    expect(filtered.map((item) => item.name)).toEqual(["Team cloud"]);
  });

  it("matches query across name, description, author, and tags", () => {
    const demo = entry({ tags: ["finance"] });
    expect(matchesCommunityCatalogQuery(demo, "demo")).toBe(true);
    expect(matchesCommunityCatalogQuery(demo, "finance")).toBe(true);
    expect(matchesCommunityCatalogQuery(demo, "missing")).toBe(false);
  });

  it("builds install commands for non-owned apps only", () => {
    const listings = buildAgentCommunityAppListings(
      [
        entry({ name: "Fork me" }),
        entry({
          name: "Mine",
          isOwned: true,
          slug: "mine",
        }),
        entry({
          name: "Missing slug",
          slug: null,
        }),
        entry({
          name: "Team shared",
          visibility: "team",
        }),
      ],
      "global",
    );

    expect(listings).toHaveLength(3);
    // v5: one Install. Every non-owned listing has a ready command with no
    // mode, and no choice to put to the user.
    expect(listings[0]?.name).toBe("Fork me");
    expect(listings[0]?.requiresInstallModeChoice).toBe(false);
    expect(listings[0]?.installOptions).toEqual([]);
    expect(listings[0]?.installCommand).toContain("install_cloud_app(");
    expect(listings[0]?.installCommand).not.toContain("mode:");
    expect(listings[1]?.name).toBe("Mine");
    expect(listings[1]?.installCommand).toBeNull();
    expect(listings[2]?.name).toBe("Team shared");
    expect(listings[2]?.requiresInstallModeChoice).toBe(false);
  });

  it("v5: team-shared namespace apps get the same one Install command", () => {
    const listings = buildAgentCommunityAppListings(
      [entry({ name: "Collaborate", visibility: "team" })],
      "namespace",
    );

    expect(listings[0]?.requiresInstallModeChoice).toBe(false);
    expect(listings[0]?.installOptions).toEqual([]);
    expect(listings[0]?.installCommand).toContain('catalogScope: "team"');
    expect(listings[0]?.installCommand).not.toContain("mode:");
  });
});
