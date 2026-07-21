import { describe, expect, test } from "vitest";
import type { MemoryObject } from "@papr/memory/resources/shared.js";
import {
  buildMemoryGraphCatalogBlock,
  buildPaprMemoryCatalogBlock,
  buildWikiGraphCatalogBlock,
  findWikiEntitiesMatchingQuery,
  isMemoryGraphCatalogBlock,
  isPaprMemoryCatalogBlock,
  isWikiGraphCatalogBlock,
  PAPR_MEMORY_CATALOG_PREFIX,
  WIKI_GRAPH_CATALOG_PREFIX,
} from "../src/gateway/services/memoryGraphCatalog.js";
import type { WikiHomeResult } from "../src/gateway/services/KnowledgeGraphWikiService.js";
import {
  isMemoryContextUserMessage,
  memoryContextSatisfiesSearchGate,
} from "../src/gateway/services/UserMemoryContextService.js";

function memory(content: string, id = "mem-abc"): MemoryObject {
  return {
    id,
    acl: {},
    content,
    type: "fact",
    user_id: "user-1",
    category: "fact",
  };
}

const wikiFixture: WikiHomeResult = {
  configured: true,
  featured: {
    id: "myadvice",
    type: "project",
    label: "MyAdvice audit workbench",
    description: "GTM audit client portal",
    props: {},
  },
  typeCounts: { project: 1, person: 2 },
  rails: [
    {
      title: "Projects",
      items: [
        {
          id: "project/myadvice",
          type: "project",
          label: "MyAdvice audit workbench",
          description: "GTM audit client portal",
          props: {},
        },
      ],
    },
    {
      title: "People",
      items: [
        {
          id: "person/dale",
          type: "person",
          label: "Dale",
          description: "Client lead",
          props: {},
        },
        {
          id: "person/patrick-hartigan",
          type: "person",
          label: "Patrick Hartigan",
          description: "MyAdvice AE",
          props: {},
        },
      ],
    },
  ],
};

describe("memoryGraphCatalog", () => {
  test("builds split wiki block with matched entities", () => {
    const block = buildWikiGraphCatalogBlock({
      wiki: wikiFixture,
      userMessage: "what do you know about patrick?",
    });

    expect(block).toBeDefined();
    expect(block!).toContain(WIKI_GRAPH_CATALOG_PREFIX);
    expect(block!).toContain("Patrick Hartigan");
    expect(block!).toContain("Matched to your message");
    expect(block!).toContain("get_wiki_entity");
    expect(isWikiGraphCatalogBlock(block!)).toBe(true);
  });

  test("findWikiEntitiesMatchingQuery matches partial names", () => {
    const matches = findWikiEntitiesMatchingQuery(
      wikiFixture,
      "tell me about patrick",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.label).toBe("Patrick Hartigan");
  });

  test("builds Papr-only deferred block", () => {
    const block = buildPaprMemoryCatalogBlock({
      tier0: [memory("Swayable GTM audit PDF indexed", "mem-pdf")],
      tier1: [memory("RR <> Papr call Jun 19 summary", "mem-call")],
      relatedMemories: [memory("Report vs Analysis split discussion")],
    });

    expect(block).toBeDefined();
    expect(block!).toContain(PAPR_MEMORY_CATALOG_PREFIX);
    expect(block!).toContain("memoryId: `mem-pdf`");
    expect(block!).toContain("Matched to current message");
    expect(isPaprMemoryCatalogBlock(block!)).toBe(true);
  });

  test("builds combined block for inspect mode", () => {
    const block = buildMemoryGraphCatalogBlock({
      wiki: wikiFixture,
      tier0: [memory("goal")],
      tier1: [],
      userMessage: "patrick",
    });

    expect(block).toBeDefined();
    expect(block!).toContain(WIKI_GRAPH_CATALOG_PREFIX);
    expect(block!).toContain(PAPR_MEMORY_CATALOG_PREFIX);
    expect(isMemoryGraphCatalogBlock(block!)).toBe(true);
  });

  test("returns undefined when all sections empty", () => {
    expect(
      buildWikiGraphCatalogBlock({
        wiki: {
          configured: false,
          featured: null,
          rails: [],
          typeCounts: {},
        },
      }),
    ).toBeUndefined();
  });

  test("wiki catalog block satisfies memory search gate", () => {
    const block = buildWikiGraphCatalogBlock({ wiki: wikiFixture });
    expect(block).toBeDefined();
    if (!block) {
      return;
    }
    expect(memoryContextSatisfiesSearchGate([block])).toBe(true);
    expect(isMemoryContextUserMessage(block)).toBe(true);
  });
});
