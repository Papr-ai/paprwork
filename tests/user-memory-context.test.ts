import { describe, expect, test } from "vitest";
import type { MemoryObject } from "@papr/memory/resources/shared.js";
import {
  formatMessageSearchBlock,
  formatSyncTiersBlock,
  IDLE_THRESHOLD_MS,
  shouldBootstrapUserMemory,
} from "../src/gateway/services/UserMemoryContextService.js";

function memory(content: string, category?: string): MemoryObject {
  return {
    id: "mem-1",
    acl: {},
    content,
    type: "fact",
    user_id: "user-1",
    category: category ?? null,
  };
}

describe("UserMemoryContextService helpers", () => {
  test("shouldBootstrapUserMemory returns true for empty history", () => {
    expect(shouldBootstrapUserMemory([])).toBe(true);
  });

  test("shouldBootstrapUserMemory returns true for first user message only", () => {
    expect(
      shouldBootstrapUserMemory([{ role: "user", content: "hello" }]),
    ).toBe(true);
  });

  test("shouldBootstrapUserMemory returns false for active conversation", () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(
      shouldBootstrapUserMemory([
        { role: "user", content: "first", timestamp: recent },
        { role: "assistant", content: "reply", timestamp: recent },
        { role: "user", content: "follow up", timestamp: recent },
      ]),
    ).toBe(false);
  });

  test("shouldBootstrapUserMemory returns true after idle threshold", () => {
    const stale = new Date(Date.now() - IDLE_THRESHOLD_MS - 1000).toISOString();
    const now = new Date().toISOString();
    expect(
      shouldBootstrapUserMemory([
        { role: "user", content: "old", timestamp: stale },
        { role: "assistant", content: "old reply", timestamp: stale },
        { role: "user", content: "back after idle", timestamp: now },
      ]),
    ).toBe(true);
  });

  test("shouldBootstrapUserMemory ignores non-conversational roles", () => {
    expect(
      shouldBootstrapUserMemory([
        { role: "system", content: "instructions" },
        { role: "user", content: "hello" },
      ]),
    ).toBe(true);
  });

  test("formatSyncTiersBlock includes cross-chat label", () => {
    const block = formatSyncTiersBlock(
      [memory("Ship v2 by Q2", "goal")],
      [memory("Prefers concise answers", "preference")],
    );

    expect(block).toContain("[CROSS-CHAT USER CONTEXT");
    expect(block).toContain("Tier 0");
    expect(block).toContain("Tier 1");
    expect(block).toContain("Ship v2 by Q2");
  });

  test("formatMessageSearchBlock includes related memory label", () => {
    const block = formatMessageSearchBlock([
      memory("User uses Neon PostgreSQL for analytics"),
    ]);

    expect(block).toContain("[RELATED MEMORY");
    expect(block).toContain("Neon PostgreSQL");
  });

  test("format blocks return undefined when empty", () => {
    expect(formatSyncTiersBlock([], [])).toBeUndefined();
    expect(formatMessageSearchBlock([])).toBeUndefined();
  });
});
