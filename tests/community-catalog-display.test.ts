import { describe, expect, it } from "vitest";
import type { CommunityCatalogEntry } from "../src/core/types/communityCatalog";
import {
  filterCatalogDisplayTags,
  getCatalogByline,
  getCatalogShareBadge,
} from "../ui/utils/communityCatalogDisplay";

describe("communityCatalogDisplay", () => {
  it("removes internal and integration category tags", () => {
    expect(filterCatalogDisplayTags(["cloud", "team", "dashboard", "ai"])).toEqual([
      "Dashboard",
    ]);
  });

  it("uses plain author byline for cloud apps", () => {
    const entry: CommunityCatalogEntry = {
      catalogId: "cloud:1",
      source: "cloud",
      name: "App",
      description: "",
      version: "cloud",
      author: "Dale Zwizinski",
      tags: [],
      visibility: "team",
      codeInstallable: false,
      liveViewable: true,
    };
    expect(getCatalogByline(entry)).toBe("By Dale Zwizinski");
    expect(getCatalogShareBadge(entry)).toBe("Team app");
  });

  it("does not show a share badge for public community apps", () => {
    const entry: CommunityCatalogEntry = {
      catalogId: "cloud:2",
      source: "cloud",
      name: "App",
      description: "",
      version: "cloud",
      author: "Author",
      tags: [],
      visibility: "public_read",
      codeInstallable: true,
      liveViewable: true,
    };
    expect(getCatalogShareBadge(entry)).toBeNull();
  });
});
