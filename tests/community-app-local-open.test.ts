import { describe, expect, test } from "vitest";

import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog.js";
import {
  canInstallCloudCatalogEntry,
  cloudSourceKey,
  resolveLocalAppIdForCatalogEntry,
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
  test("returns publisher app id when owned locally", () => {
    const entry = cloudEntry({ appId: "owned-app", isOwned: true });
    const installed = new Set(["owned-app"]);
    expect(resolveLocalAppIdForCatalogEntry(entry, installed, null)).toBe("owned-app");
  });

  test("returns owned app id even when My Apps list omits it", () => {
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
    const entry = cloudEntry({ appId: "app-1" });
    const lineage: CloudLineageIndex = {
      byAppId: {},
      bySourceKey: {
        [cloudSourceKey("ns-work", "team-app")]: ["fork-app-id"],
      },
    };
    const installed = new Set(["app-1", "fork-app-id"]);
    expect(resolveLocalAppIdForCatalogEntry(entry, installed, lineage)).toBe("app-1");
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

  test("blocks install for owned or already-local apps", () => {
    const entry = cloudEntry({ codeInstallable: true, isOwned: true });
    expect(canInstallCloudCatalogEntry(entry, "owned-app")).toBe(false);
  });

  test("blocks install when code access is live-only", () => {
    const entry = cloudEntry({ codeInstallable: false });
    expect(canInstallCloudCatalogEntry(entry, null)).toBe(false);
  });
});
