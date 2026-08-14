import { describe, expect, it } from "vitest";
import { resolveEntityDirConfig } from "../src/gateway/services/KnowledgeGraphWikiService.js";

describe("wiki entity directories", () => {
  it("resolves known Sleep/Wiki entity folders", () => {
    expect(resolveEntityDirConfig("people")).toEqual({
      railTitle: "People",
      singular: "person",
    });
    expect(resolveEntityDirConfig("meetings")).toEqual({
      railTitle: "Meetings",
      singular: "meeting",
    });
    expect(resolveEntityDirConfig("decisions")).toEqual({
      railTitle: "Decisions",
      singular: "decision",
    });
    expect(resolveEntityDirConfig("workflows")).toEqual({
      railTitle: "Workflows",
      singular: "workflow",
    });
  });

  it("auto-discovers unknown entity folders", () => {
    expect(resolveEntityDirConfig("partnerships")).toEqual({
      railTitle: "Partnerships",
      singular: "partnership",
    });
  });
});
