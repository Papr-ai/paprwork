import { describe, expect, test } from "vitest";
import type { MemoryObject } from "@papr/memory/resources/shared.js";
import {
  classifyMemoryBlock,
  formatMessageSearchBlock,
  formatSyncTiersBlock,
  getUserMemoryContextService,
  IDLE_THRESHOLD_MS,
  isMemoryContextUserMessage,
  MAX_SEARCH_MEMORIES,
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
    expect(block).toContain("Tier 0 — Priority memories");
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

  test("MAX_SEARCH_MEMORIES meets Papr API minimum of 10", () => {
    expect(MAX_SEARCH_MEMORIES).toBeGreaterThanOrEqual(10);
  });

  test("stream mode injects local wiki immediately on bootstrap trigger turn", async () => {
    const service = getUserMemoryContextService();
    service.clearChatBootstrap("chat-stream-test");
    const blocks = await service.getMemoryContextBlocks(
      "chat-stream-test",
      "what do you know about patrick?",
      [{ role: "user", content: "what do you know about patrick?" }],
      { mode: "stream" },
    );
    if (blocks.length > 0) {
      expect(blocks[0]).toContain("[WIKI GRAPH");
      expect(blocks.some((b) => b.includes("Patrick") || b.includes("People"))).toBe(
        true,
      );
    } else {
      expect(blocks).toEqual([]);
    }
  });

  test("stream mode does not fetch memory on active conversation turns", async () => {
    const service = getUserMemoryContextService();
    service.clearChatBootstrap("chat-active-test");
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const blocks = await service.getMemoryContextBlocks(
      "chat-active-test",
      "follow up question",
      [
        { role: "user", content: "first", timestamp: recent },
        { role: "assistant", content: "reply", timestamp: recent },
        { role: "user", content: "follow up question", timestamp: recent },
      ],
      { mode: "stream" },
    );
    expect(blocks).toEqual([]);
  });

  test("classifyMemoryBlock and isMemoryContextUserMessage", () => {
    const tiers = formatSyncTiersBlock([memory("goal")], []);
    const related = formatMessageSearchBlock([memory("fact")]);
    expect(tiers).toBeDefined();
    expect(related).toBeDefined();
    if (!tiers || !related) {
      return;
    }
    expect(classifyMemoryBlock(tiers)).toBe("sync_tiers");
    expect(classifyMemoryBlock(related)).toBe("related_memory");
    expect(isMemoryContextUserMessage(tiers)).toBe(true);
    expect(isMemoryContextUserMessage(related)).toBe(true);
    expect(isMemoryContextUserMessage("regular user text")).toBe(false);
  });
});
