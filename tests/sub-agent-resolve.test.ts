import { describe, expect, test } from "vitest";
import { resolveSubAgentProfile } from "../src/gateway/services/SubAgentService.js";
import type { SubAgentProfile } from "../src/core/types/subagents.js";

const now = new Date().toISOString();

function profile(
  id: string,
  name: string,
): SubAgentProfile {
  return {
    id,
    name,
    description: name,
    systemPrompt: "test",
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  };
}

const profiles = [
  profile("coordinator", "Coordinator"),
  profile("agent-6aecbf6f-2adc-43f1-933c-af1601531ec0", "GTM Product Architect"),
  profile("research-specialist", "Research Specialist"),
];

describe("resolveSubAgentProfile", () => {
  test("rejects missing useAgentId instead of falling back to first agent", () => {
    const result = resolveSubAgentProfile(profiles, undefined);
    expect(result.profile).toBeNull();
    expect(result.error).toContain("useAgentId is required");
    expect(result.profile?.id).not.toBe("coordinator");
  });

  test("rejects empty useAgentId", () => {
    const result = resolveSubAgentProfile(profiles, "   ");
    expect(result.profile).toBeNull();
    expect(result.error).toContain("useAgentId is required");
  });

  test("matches exact id", () => {
    const result = resolveSubAgentProfile(
      profiles,
      "agent-6aecbf6f-2adc-43f1-933c-af1601531ec0",
    );
    expect(result.profile?.name).toBe("GTM Product Architect");
  });

  test("matches case-insensitive display name", () => {
    const result = resolveSubAgentProfile(profiles, "coordinator");
    expect(result.profile?.id).toBe("coordinator");
  });

  test("matches partial uuid fragment when unique", () => {
    const result = resolveSubAgentProfile(profiles, "6aecbf6f");
    expect(result.profile?.id).toBe("agent-6aecbf6f-2adc-43f1-933c-af1601531ec0");
  });

  test("returns error for unknown agent", () => {
    const result = resolveSubAgentProfile(profiles, "nonexistent-agent");
    expect(result.profile).toBeNull();
    expect(result.error).toContain("Sub-agent not found");
    expect(result.error).toContain("coordinator");
  });
});
