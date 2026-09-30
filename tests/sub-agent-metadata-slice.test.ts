import { describe, expect, it } from "vitest";
import type { SubAgentProfile } from "../src/core/types/subagents.js";
import {
  listCustomSubAgentConfigEntries,
  toSubAgentConfigIndexEntry,
} from "../src/gateway/services/subagents/subAgentMetadataSlice.js";

const customProfile: SubAgentProfile = {
  id: "agent-abc-123",
  name: "Deck Assistant",
  description: "Helps with decks",
  systemPrompt: "You are helpful",
  allowedToolIds: ["bash"],
  assignedSkills: [],
  outputMode: "natural",
  maxTurns: 10,
  memoryPolicy: "none",
  icon: "robot",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  runCount: 42,
  lastRunAt: "2026-01-03T00:00:00.000Z",
};

describe("subAgentMetadataSlice", () => {
  it("includes config fields and excludes local runtime stats", () => {
    const entry = toSubAgentConfigIndexEntry(customProfile);
    expect(entry).toMatchObject({
      id: "agent-abc-123",
      name: "Deck Assistant",
      systemPrompt: "You are helpful",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(entry).not.toHaveProperty("runCount");
    expect(entry).not.toHaveProperty("lastRunAt");
  });

  it("skips built-in profiles", () => {
    const builtIn: SubAgentProfile = {
      ...customProfile,
      id: "research-specialist",
    };
    expect(toSubAgentConfigIndexEntry(builtIn)).toBeNull();
  });

  it("lists only custom agent-* profiles", () => {
    const entries = listCustomSubAgentConfigEntries([
      customProfile,
      { ...customProfile, id: "research-specialist" },
      { ...customProfile, id: "agent-other" },
    ]);
    expect(entries.map((entry) => entry.id)).toEqual([
      "agent-abc-123",
      "agent-other",
    ]);
  });
});
