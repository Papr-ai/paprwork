import { describe, expect, it } from "vitest";
import { buildPaprApiCatalog } from "../src/core/paprApiCatalog/buildCatalog.js";
import { MINI_APP_HTTP_CATALOG_ENTRIES } from "../src/core/paprApiCatalog/miniAppHttpEntries.js";
import { searchPaprApiCatalog } from "../src/core/paprApiCatalog/searchCatalog.js";
import { allTools, getAllToolIds } from "../src/core/tools/index.js";

describe("papr-api-catalog", () => {
  it("includes every agent tool in the built catalog", () => {
    const catalog = buildPaprApiCatalog();
    const toolIds = new Set(
      catalog.entries.filter((e) => e.toolId).map((e) => e.toolId),
    );
    for (const id of getAllToolIds()) {
      expect(toolIds.has(id), `missing tool catalog entry for ${id}`).toBe(true);
    }
    expect(catalog.entries.length).toBeGreaterThan(allTools.length);
  });

  it("finds db batch read and write-batch by query", () => {
    const catalog = buildPaprApiCatalog();
    const readHits = searchPaprApiCatalog(catalog, {
      query: "db batch read",
      surface: "mini-app-http",
      limit: 5,
    });
    expect(readHits.some((h) => h.entry.id === "db-batch-read")).toBe(true);

    const writeHits = searchPaprApiCatalog(catalog, {
      query: "write-batch atomic",
      surface: "mini-app-http",
      limit: 5,
    });
    expect(writeHits.some((h) => h.entry.id === "db-write-batch")).toBe(true);
  });

  it("HTTP entries document batch aliases and limits", () => {
    const batch = MINI_APP_HTTP_CATALOG_ENTRIES.find((e) => e.id === "db-batch-read");
    expect(batch?.pathAliases).toContain("/api/db/read-batch");
    expect(batch?.limits?.some((l) => l.includes("25"))).toBe(true);
  });

  it("ranks agent-tool surface for create_app query", () => {
    const catalog = buildPaprApiCatalog();
    const hits = searchPaprApiCatalog(catalog, {
      query: "create_app",
      surface: "agent-tool",
      limit: 3,
    });
    expect(hits[0]?.entry.toolId).toBe("create_app");
  });
});
