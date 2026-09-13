/**
 * Related memories must carry one entry per id.
 *
 * The UI keys this list by id and looks up the open memory with a find-by-id,
 * so a repeated id both breaks React reconciliation and makes "which one is
 * open" ambiguous. Search returns a memory once per matching chunk, so the
 * duplication is expected upstream and has to be collapsed here.
 */

import { describe, it, expect } from "vitest";
import { toRelatedMemories } from "../src/gateway/services/KnowledgeGraphWikiService";

const hit = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  content: `content for ${id}`,
  category: "fact",
  source: "chat",
  created_at: "2026-09-07T00:00:00Z",
  chat_id: "chat-1",
  ...extra,
});

describe("toRelatedMemories", () => {
  it("collapses repeated ids to a single entry", () => {
    const result = toRelatedMemories([hit("a"), hit("a"), hit("b")]);

    expect(result.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("yields ids that are unique, which is what the React key requires", () => {
    const result = toRelatedMemories([
      hit("a"),
      hit("b"),
      hit("a"),
      hit("c"),
      hit("b"),
    ]);

    expect(new Set(result.map((m) => m.id)).size).toBe(result.length);
  });

  it("keeps the first hit for an id, so the strongest match wins", () => {
    // Search returns hits strongest-first; a later chunk of the same memory
    // must not overwrite the content that ranked highest.
    const result = toRelatedMemories([
      hit("a", { content: "strongest match" }),
      hit("a", { content: "weaker chunk" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("strongest match");
  });

  it("preserves search order for distinct ids", () => {
    const result = toRelatedMemories([hit("c"), hit("a"), hit("b")]);

    expect(result.map((m) => m.id)).toEqual(["c", "a", "b"]);
  });

  it("drops hits with no id, since they cannot be keyed or looked up", () => {
    const result = toRelatedMemories([hit("a"), hit(""), { content: "x" }]);

    expect(result.map((m) => m.id)).toEqual(["a"]);
  });

  it("drops hits with no content, which would render an empty card", () => {
    const result = toRelatedMemories([
      hit("a"),
      { id: "b", content: "" },
      { id: "c" },
    ]);

    expect(result.map((m) => m.id)).toEqual(["a"]);
  });

  it("coerces non-string fields rather than emitting undefined", () => {
    // The payload is untyped, so a number where a string is expected must not
    // reach the UI as a non-string.
    const result = toRelatedMemories([
      { id: 42, content: "body", category: 7, chat_id: null },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("42");
    expect(result[0].category).toBe("7");
    expect(result[0].chatId).toBe("");
  });

  it("returns an empty list for no hits", () => {
    expect(toRelatedMemories([])).toEqual([]);
  });
});
