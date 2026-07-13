import { describe, expect, it } from "vitest";
import { collectWikiNodes, normalizeWikiNode } from "../types/wiki";

describe("wiki node helpers", () => {
  it("normalizeWikiNode fills missing fields from partial cache", () => {
    const node = normalizeWikiNode({
      id: "person/alice",
      type: "person",
      label: "Alice",
    });
    expect(node.props).toEqual({});
    expect(node.description).toBe("");
  });

  it("normalizeWikiNode sorts evidence newest first", () => {
    const node = normalizeWikiNode({
      id: "person/alice",
      type: "person",
      label: "Alice",
      evidence: [
        { date: "2026-01-01", source: "chat", summary: "Oldest" },
        { date: "2026-07-08", source: "chat", summary: "Newest" },
        { date: "2026-03-15", source: "chat", summary: "Middle" },
      ],
    });
    expect(node.evidence?.map((e) => e.summary)).toEqual([
      "Newest",
      "Middle",
      "Oldest",
    ]);
  });

  it("collectWikiNodes reads rail items not nodes", () => {
    const nodes = collectWikiNodes({
      featured: null,
      rails: [
        {
          title: "People",
          items: [
            {
              id: "person/bob",
              type: "person",
              label: "Bob",
              description: "",
              props: {},
            },
          ],
        },
      ],
      typeCounts: { person: 1 },
      configured: true,
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.label).toBe("Bob");
  });
});
