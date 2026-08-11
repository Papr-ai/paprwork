import { describe, expect, it } from "vitest";
import {
  formatCatalogDisplayTags,
  normalizeCatalogTags,
  resolveCatalogEntryTags,
  sanitizeExplicitCatalogTags,
} from "../src/core/utils/catalogTags";

describe("catalogTags", () => {
  it("normalizes topic tag input", () => {
    expect(normalizeCatalogTags([" GTM ", "sales-analytics", "Dashboard"])).toEqual([
      "dashboard",
      "gtm",
      "sales-analytics",
    ]);
  });

  it("drops integration categories from legacy API tags", () => {
    expect(sanitizeExplicitCatalogTags(["ai", "crm", "dashboard", "other"])).toEqual([
      "dashboard",
    ]);
  });

  it("prefers manifest tags over API tags", () => {
    expect(
      resolveCatalogEntryTags({
        tags: ["ai", "other"],
        manifestTags: ["gtm", "dashboard"],
      }),
    ).toEqual(["dashboard", "gtm"]);
  });

  it("formats human-readable chip labels", () => {
    expect(formatCatalogDisplayTags(["gtm", "sales-analytics", "ai"])).toEqual([
      "GTM",
      "Sales Analytics",
    ]);
  });
});
