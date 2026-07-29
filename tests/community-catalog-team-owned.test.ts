import { describe, expect, it, vi } from "vitest";

import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog.js";
import { shouldIncludeInPublicCommunity } from "../src/gateway/services/CommunityCatalogService.js";

vi.mock("../src/gateway/services/cloudPublishPrefs.js", () => ({
  getAppPublishPrefs: vi.fn(() => ({
    loginAccess: "team",
    externalLink: false,
    codeAccess: "off",
  })),
}));

function cloudEntry(
  overrides: Partial<CommunityCatalogEntry> = {},
): CommunityCatalogEntry {
  return {
    catalogId: "cloud:app-1",
    source: "cloud",
    name: "Team App",
    description: "",
    version: "cloud",
    author: "You",
    tags: [],
    appId: "app-1",
    namespaceId: "ns-work",
    codeInstallable: false,
    liveViewable: true,
    ...overrides,
  };
}

describe("shouldIncludeInPublicCommunity — team apps for owners", () => {
  const paprDir = "/tmp/papr-test";
  const ownedAppIds = new Set(["app-1"]);

  it("includes team visibility entries in workspace catalog", () => {
    const entry = cloudEntry({ visibility: "team", publisherUserId: "user-me" });
    expect(
      shouldIncludeInPublicCommunity(entry, paprDir, ownedAppIds, {
        allowTeam: true,
      }),
    ).toBe(true);
  });

  it("includes owned team-shared apps via local prefs when allowTeam is set", () => {
    const entry = cloudEntry({
      visibility: "public_read",
      isOwned: true,
      publisherUserId: "user-me",
    });
    expect(
      shouldIncludeInPublicCommunity(entry, paprDir, ownedAppIds, {
        allowTeam: true,
      }),
    ).toBe(true);
  });

  it("excludes team visibility from global community catalog", () => {
    const entry = cloudEntry({ visibility: "team" });
    expect(shouldIncludeInPublicCommunity(entry, paprDir, ownedAppIds)).toBe(
      false,
    );
  });
});
