import { describe, expect, test } from "vitest";

import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog.js";
import {
  canInstallCloudCatalogEntry,
  cloudSourceKey,
  resolveLocalAppIdForCatalogEntry,
  shouldOpenCatalogEntryLocally,
  type CloudLineageIndex,
} from "../ui/utils/communityAppLocalOpen.js";

function cloudEntry(
  overrides: Partial<CommunityCatalogEntry> = {},
): CommunityCatalogEntry {
  return {
    catalogId: "cloud:app-1",
    source: "cloud",
    name: "Team App",
    description: "",
    version: "cloud",
    author: "Teammate",
    tags: [],
    appId: "app-1",
    namespaceId: "ns-work",
    slug: "team-app",
    codeInstallable: true,
    liveViewable: true,
    ...overrides,
  };
}

describe("resolveLocalAppIdForCatalogEntry", () => {
  test("returns publisher app id when owned and installed locally", () => {
    const entry = cloudEntry({ appId: "owned-app", isOwned: true });
    const installed = new Set(["owned-app"]);
    expect(resolveLocalAppIdForCatalogEntry(entry, installed, null)).toBe("owned-app");
  });

  test("returns owned app id even when artifacts cache has not loaded yet", () => {
    const entry = cloudEntry({ appId: "owned-app", isOwned: true });
    expect(resolveLocalAppIdForCatalogEntry(entry, new Set(), null)).toBe("owned-app");
  });

  test("returns fork id when only a fork is installed", () => {
    const entry = cloudEntry();
    const lineage: CloudLineageIndex = {
      byAppId: {},
      bySourceKey: {
        [cloudSourceKey("ns-work", "team-app")]: ["fork-app-id"],
      },
    };
    const installed = new Set(["fork-app-id"]);
    expect(resolveLocalAppIdForCatalogEntry(entry, installed, lineage)).toBe(
      "fork-app-id",
    );
  });

  test("prefers publisher copy over fork when both exist", () => {
    const entry = cloudEntry({ appId: "app-1", isOwned: true });
    const lineage: CloudLineageIndex = {
      byAppId: {},
      bySourceKey: {
        [cloudSourceKey("ns-work", "team-app")]: ["fork-app-id"],
      },
    };
    const installed = new Set(["app-1", "fork-app-id"]);
    expect(resolveLocalAppIdForCatalogEntry(entry, installed, lineage)).toBe("app-1");
  });

  test("ignores synced workspace app id for teammate catalog entries", () => {
    const entry = cloudEntry({ appId: "app-1", isOwned: false });
    const installed = new Set(["app-1"]);
    expect(resolveLocalAppIdForCatalogEntry(entry, installed, null)).toBeNull();
  });

  test("returns null when app is not local", () => {
    const entry = cloudEntry();
    expect(resolveLocalAppIdForCatalogEntry(entry, new Set(), null)).toBeNull();
  });
});

describe("canInstallCloudCatalogEntry", () => {
  test("allows install when code is installable and app is not local", () => {
    const entry = cloudEntry({ codeInstallable: true });
    expect(canInstallCloudCatalogEntry(entry, null)).toBe(true);
  });

  test("allows customize when teammate app is synced locally but not owned", () => {
    const entry = cloudEntry({ codeInstallable: true, isOwned: false });
    expect(canInstallCloudCatalogEntry(entry, null)).toBe(true);
  });

  test("blocks install for owned or already-local apps", () => {
    const entry = cloudEntry({ codeInstallable: true, isOwned: true });
    expect(canInstallCloudCatalogEntry(entry, "owned-app")).toBe(false);
  });

  test("blocks install when code access is live-only", () => {
    const entry = cloudEntry({ codeInstallable: false });
    expect(canInstallCloudCatalogEntry(entry, null)).toBe(false);
  });
});

describe("shouldOpenCatalogEntryLocally", () => {
  test("opens local tab when publisher copy is installed", () => {
    const entry = cloudEntry({ appId: "owned-app", isOwned: true });
    expect(
      shouldOpenCatalogEntryLocally(entry, new Set(["owned-app"]), null),
    ).toBe(true);
  });

  test("opens local tab for owned app before artifacts cache is warm", () => {
    const entry = cloudEntry({ appId: "owned-app", isOwned: true });
    expect(
      shouldOpenCatalogEntryLocally(entry, new Set(), null),
    ).toBe(true);
  });

  test("opens local tab when teammate fork is installed", () => {
    const entry = cloudEntry({ appId: "team-app", isOwned: false });
    const lineage: CloudLineageIndex = {
      byAppId: {},
      bySourceKey: {
        [cloudSourceKey("ns-work", "team-app")]: ["fork-app-id"],
      },
    };
    expect(
      shouldOpenCatalogEntryLocally(entry, new Set(["fork-app-id"]), lineage),
    ).toBe(true);
  });

  test("does not open locally for teammate apps without a fork", () => {
    const entry = cloudEntry({ appId: "team-app", isOwned: false });
    expect(
      shouldOpenCatalogEntryLocally(entry, new Set(["team-app"]), null),
    ).toBe(false);
  });
});
