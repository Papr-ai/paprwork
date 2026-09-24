import { describe, expect, test } from "vitest";

import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog.js";
import {
  shouldShowInCommunityBrowse,
  sortCommunityEntriesInstallableFirst,
} from "../ui/utils/communityCatalogBrowseFilter.js";

function cloudEntry(
  overrides: Partial<CommunityCatalogEntry> = {},
): CommunityCatalogEntry {
  return {
    catalogId: "cloud:app-1",
    source: "cloud",
    name: "App",
    description: "",
    version: "cloud",
    author: "Author",
    tags: [],
    appId: "app-1",
    codeInstallable: true,
    liveViewable: true,
    ...overrides,
  };
}

describe("communityCatalogBrowseFilter", () => {
  test("hides preview-only cloud entries, including owned shares", () => {
    const previewOnly = cloudEntry({ codeInstallable: false, liveViewable: true });
    const ownedPreview = cloudEntry({
      isOwned: true,
      codeInstallable: false,
      liveViewable: true,
    });
    expect(shouldShowInCommunityBrowse(previewOnly)).toBe(false);
    expect(shouldShowInCommunityBrowse(ownedPreview)).toBe(false);
  });

  test("shows installable cloud entries and open-source bundles", () => {
    expect(shouldShowInCommunityBrowse(cloudEntry({ codeInstallable: true }))).toBe(true);
    expect(
      shouldShowInCommunityBrowse(
        cloudEntry({ source: "opensource", codeInstallable: false }),
      ),
    ).toBe(true);
  });

  test("sorts installable entries before preview-only", () => {
    const sorted = sortCommunityEntriesInstallableFirst([
      cloudEntry({ name: "Preview", codeInstallable: false, liveViewable: true }),
      cloudEntry({ name: "Installable", codeInstallable: true }),
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual([
      "Installable",
      "Preview",
    ]);
  });
});
