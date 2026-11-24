import { describe, expect, test } from "vitest";

/** Mirror of paprDocumentMemory extractMemoriesFromSearchResponse for unit testing. */
function extractMemoriesFromSearchResponse(
  response: unknown,
): Array<{ memoryId: string; content: string }> {
  const root = response as Record<string, unknown>;
  const inner = (root.data ?? root) as Record<string, unknown>;
  const memories = inner.memories;
  if (!Array.isArray(memories)) {
    return [];
  }

  const hits: Array<{ memoryId: string; content: string }> = [];
  for (const entry of memories) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const memory = entry as Record<string, unknown>;
    const content =
      typeof memory.content === "string" ? memory.content.trim() : "";
    const memoryId =
      typeof memory.id === "string"
        ? memory.id
        : typeof memory.memoryId === "string"
          ? memory.memoryId
          : undefined;
    if (memoryId && content.length >= 200) {
      hits.push({ memoryId, content });
    }
  }
  return hits;
}

describe("parsePdfMemoryLookup", () => {
  test("extracts memories with sufficient content from search response", () => {
    const shortContent = "x".repeat(100);
    const longContent = "y".repeat(250);

    const hits = extractMemoriesFromSearchResponse({
      data: {
        memories: [
          { id: "mem-short", content: shortContent },
          { id: "mem-long", content: longContent },
        ],
      },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe("mem-long");
  });
});
