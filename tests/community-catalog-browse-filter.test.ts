import { describe, expect, test } from "vitest";

import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog.js";
import {
  countHiddenPreviewOnlyCommunityEntries,
  isPreviewOnlyCommunityEntry,
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
  test("detects preview-only cloud entries", () => {
    expect(
      isPreviewOnlyCommunityEntry(
        cloudEntry({ codeInstallable: false, liveViewable: true }),
      ),
    ).toBe(true);
    expect(
      isPreviewOnlyCommunityEntry(
        cloudEntry({ codeInstallable: true, liveViewable: true }),
      ),
    ).toBe(false);
  });

  test("hides preview-only entries by default but keeps owned apps", () => {
    const previewOnly = cloudEntry({
      name: "Preview",
      codeInstallable: false,
      liveViewable: true,
    });
    const ownedPreview = cloudEntry({
      name: "Mine",
      isOwned: true,
      codeInstallable: false,
      liveViewable: true,
    });
    const installable = cloudEntry({
      name: "Installable",
      codeInstallable: true,
    });

    expect(
      shouldShowInCommunityBrowse(previewOnly, { showPreviewOnly: false }),
    ).toBe(false);
    expect(
      shouldShowInCommunityBrowse(ownedPreview, { showPreviewOnly: false }),
    ).toBe(true);
    expect(
      shouldShowInCommunityBrowse(installable, { showPreviewOnly: false }),
    ).toBe(true);
    expect(
      shouldShowInCommunityBrowse(previewOnly, { showPreviewOnly: true }),
    ).toBe(true);
  });

  test("counts hidden preview-only entries excluding owned apps", () => {
    const entries = [
      cloudEntry({ codeInstallable: false, liveViewable: true }),
      cloudEntry({
        isOwned: true,
        codeInstallable: false,
        liveViewable: true,
      }),
      cloudEntry({ codeInstallable: true }),
    ];
    expect(countHiddenPreviewOnlyCommunityEntries(entries)).toBe(1);
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
