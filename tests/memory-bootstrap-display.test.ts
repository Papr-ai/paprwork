import { describe, expect, test } from "vitest";
import { parseMemoryBootstrapBlock } from "../ui/components/Chat/memoryBootstrapDisplay";

describe("parseMemoryBootstrapBlock", () => {
  test("parses sync tier block into sections and memory cards", () => {
    const content = `[CROSS-CHAT USER CONTEXT — background from other conversations; may not reflect your current task]

**Tier 0 — Priority memories (Papr-ranked; may include goals, OKRs, or conversation summaries):**
- [context] (TextMemoryItem) # Conversation Batch 1
Session: abc-123-def

## Short-term Summary
User wants admin portal redesign.

**Tier 1 — Recent / hot memories:**
- [preference] (TextMemoryItem) Prefers concise answers.

Use search_agent_memory for task-specific recall if you need more detail.`;

    const parsed = parseMemoryBootstrapBlock(content, "sync_tiers");

    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0].title).toContain("Tier 0");
    expect(parsed.sections[0].items).toHaveLength(1);
    expect(parsed.sections[0].items[0].sessionId).toBe("abc-123-def");
    expect(parsed.sections[0].items[0].title).toBe("Conversation Batch 1");
    expect(parsed.sections[1].items[0].category).toBe("preference");
    expect(parsed.footer).toContain("search_agent_memory");
  });

  test("parses Parse goals block into structured cards", () => {
    const content = `[USER GOALS & OKRs — from Papr Parse Goal class; sorted by most recently updated]

**Goal: Launch V2** (updated 2026-06-01)
Ship the rewrite with reliable agents.
Key Results:
- Beta release
- Docs complete

Align your assistance with these goals when relevant.`;

    const parsed = parseMemoryBootstrapBlock(content, "parse_goals");
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].title).toBe("Goals & OKRs");
    expect(parsed.sections[0].items[0].title).toBe("Launch V2");
    expect(parsed.sections[0].items[0].body).toContain("Key Results:");
  });

  test("parses related memory block", () => {
    const content = `[RELATED MEMORY — matched to the user's current message]

- [fact] (TextMemoryItem) Uses Neon PostgreSQL.

These may be relevant to this request. Call search_agent_memory for deeper recall.`;

    const parsed = parseMemoryBootstrapBlock(content, "related_memory");

    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].items).toHaveLength(1);
    expect(parsed.sections[0].items[0].body).toContain("Neon PostgreSQL");
  });
});
