import { describe, expect, it } from "vitest";

import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog.js";
import {
  isPublicCommunityVisibility,
  isTeamSharedVisibility,
} from "../src/core/types/communityCatalog.js";

function filterNamespaceCloudEntries(
  entries: CommunityCatalogEntry[],
  namespaceId: string,
): CommunityCatalogEntry[] {
  return entries.filter(
    (entry) => entry.source === "cloud" && entry.namespaceId === namespaceId,
  );
}

describe("namespace community catalog filtering", () => {
  const entries: CommunityCatalogEntry[] = [
    {
      catalogId: "cloud:a1",
      source: "cloud",
      name: "Team Dash",
      description: "",
      version: "cloud",
      author: "Alice",
      tags: [],
      appId: "a1",
      namespaceId: "ns-work",
      slug: "team-dash",
      codeInstallable: false,
      liveViewable: true,
    },
    {
      catalogId: "cloud:a2",
      source: "cloud",
      name: "Other NS",
      description: "",
      version: "cloud",
      author: "Bob",
      tags: [],
      appId: "a2",
      namespaceId: "ns-other",
      slug: "other",
      codeInstallable: false,
      liveViewable: true,
    },
    {
      catalogId: "oss:bundle",
      source: "opensource",
      name: "OSS Bundle",
      description: "",
      version: "1.0.0",
      author: "Papr",
      tags: [],
      codeInstallable: true,
      liveViewable: false,
    },
  ];

  it("keeps only cloud apps in the requested namespace", () => {
    const filtered = filterNamespaceCloudEntries(entries, "ns-work");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.appId).toBe("a1");
  });

  it("excludes open-source bundles", () => {
    const filtered = filterNamespaceCloudEntries(entries, "ns-work");
    expect(filtered.every((entry) => entry.source === "cloud")).toBe(true);
  });
});

describe("isTeamSharedVisibility", () => {
  it("detects team visibility modes", () => {
    expect(isTeamSharedVisibility("team")).toBe(true);
    expect(isTeamSharedVisibility("team_read")).toBe(true);
    expect(isTeamSharedVisibility("public_read")).toBe(false);
    expect(isTeamSharedVisibility(undefined)).toBe(false);
  });
});

describe("isPublicCommunityVisibility", () => {
  it("only public_read apps belong in community", () => {
    expect(isPublicCommunityVisibility("public_read")).toBe(true);
    expect(isPublicCommunityVisibility("private")).toBe(false);
    expect(isPublicCommunityVisibility("team")).toBe(false);
    expect(isPublicCommunityVisibility(undefined)).toBe(false);
  });
});
