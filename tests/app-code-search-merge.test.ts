import { describe, expect, test } from "vitest";
import {
  mergeAppCodeSearchHits,
  type AppCodeSearchHit,
} from "../src/gateway/services/AppCodeSearchService.js";

function hit(
  overrides: Partial<AppCodeSearchHit> & Pick<AppCodeSearchHit, "relativePath">,
): AppCodeSearchHit {
  return {
    memoryId: "mem-1",
    fileName: "file.ts",
    projectId: "app-1",
    projectType: "mini_app",
    snippet: "snippet",
    ...overrides,
  };
}

describe("mergeAppCodeSearchHits", () => {
  test("prefers memory hits and dedupes keyword overlap", () => {
    const memoryHits = [
      hit({ relativePath: "a.ts", score: 0.9, memoryId: "m1" }),
      hit({ relativePath: "b.ts", score: 0.8, memoryId: "m2" }),
    ];
    const keywordHits = [
      hit({ relativePath: "b.ts", memoryId: "" }),
      hit({ relativePath: "c.ts", memoryId: "" }),
    ];

    const merged = mergeAppCodeSearchHits(memoryHits, keywordHits, 10);
    expect(merged.map((h) => h.relativePath)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(merged[1]?.memoryId).toBe("m2");
  });

  test("respects limit", () => {
    const memoryHits = [hit({ relativePath: "a.ts", score: 1 })];
    const keywordHits = [
      hit({ relativePath: "b.ts" }),
      hit({ relativePath: "c.ts" }),
    ];
    expect(mergeAppCodeSearchHits(memoryHits, keywordHits, 2).length).toBe(2);
  });
});
