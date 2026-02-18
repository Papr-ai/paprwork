import { describe, expect, test } from "vitest";
import { generateFallbackTitle } from "../src/gateway/services/agent/fallbackTitle.js";

describe("agent fallback title", () => {
  test("removes common prefixes", () => {
    const title = generateFallbackTitle("can you help me debug this issue");
    expect(title).toBe("Help me debug this issue");
  });

  test("truncates long titles at word boundaries", () => {
    const title = generateFallbackTitle(
      "this is a very long message that should definitely be truncated cleanly",
    );
    expect(title.length).toBeLessThanOrEqual(43);
    expect(title.endsWith("...")).toBe(true);
  });

  test("returns New Chat for empty messages", () => {
    const title = generateFallbackTitle("   ");
    expect(title).toBe("New Chat");
  });
});
