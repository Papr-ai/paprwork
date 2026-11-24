/**
 * Guards the two places Papr controls query quality.
 *
 * The memory API is explicit that retrieval degrades with short keyword
 * queries and asks for "2-3 sentences that include specific details, context,
 * and time frame", plus max_memories 15-20 for comprehensive coverage.
 *
 * Measured against 500 recent production QueryLog rows before this change:
 *   median query length   320 words
 *   meet the guidance     62%
 *   keyword-style (<=6w)   9%  <- ALL of them came from SEARCH_RAIL_QUERIES
 *
 * Agent-authored queries were already fine. The regression risk is the fixed
 * programmatic list, because nothing about it is reviewed per-call — so it is
 * asserted here instead.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WIKI_SERVICE = join(
  process.cwd(),
  "src/gateway/services/KnowledgeGraphWikiService.ts",
);

/** Pull the query string literals out of the SEARCH_RAIL_QUERIES block. */
function railQueries(): string[] {
  const source = readFileSync(WIKI_SERVICE, "utf8");
  const start = source.indexOf("const SEARCH_RAIL_QUERIES");
  expect(start).toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf("\n];", start));
  return [...block.matchAll(/query:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)].map(
    (m) => m[1],
  );
}

const sentences = (text: string) =>
  text.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;

describe("wiki rail queries follow memory API search guidance", () => {
  const queries = railQueries();

  it("extracts every rail query", () => {
    expect(queries.length).toBeGreaterThanOrEqual(6);
  });

  it("uses 2+ sentences per query, never keyword lists", () => {
    for (const q of queries) {
      expect(sentences(q), `too few sentences: ${q}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("is descriptive enough to embed well (>=20 words)", () => {
    for (const q of queries) {
      expect(q.split(/\s+/).length, `too short: ${q}`).toBeGreaterThanOrEqual(20);
    }
  });

  it("has no bare keyword-list queries left", () => {
    // The exact strings that produced the 9% keyword tail in production.
    const retired = [
      "goals and objectives",
      "projects and initiatives",
      "people contacts stakeholders",
      "memories notes conversations",
      "insights decisions learnings",
      "tasks action items todos",
    ];
    for (const old of retired) {
      expect(queries, `keyword query still present: ${old}`).not.toContain(old);
    }
  });

  it("still names the entity type each rail is about", () => {
    // Guards against "fixing" brevity with generic prose that would retrieve
    // the same thing for every rail.
    const mustMention = ["goal", "project", "people", "memories", "insight", "task"];
    const joined = queries.map((q) => q.toLowerCase());
    for (const term of mustMention) {
      expect(
        joined.some((q) => q.includes(term)),
        `no rail query mentions "${term}"`,
      ).toBe(true);
    }
  });
});

describe("search tool recall floor", () => {
  it("requires at least 15 memories, matching the API guidance", () => {
    const source = readFileSync(
      join(process.cwd(), "src/core/tools/paprMemory.ts"),
      "utf8",
    );
    // Search FORWARD from maxMemories. `category: z` also appears earlier in
    // the file, so an unanchored indexOf returns a position before the block
    // and silently yields an empty slice — which is how the first version of
    // this test "failed" against correct source.
    const start = source.indexOf("maxMemories: z");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("category: z", start));
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain(".min(15)");
    expect(block).not.toContain(".min(10)");
  });
});
