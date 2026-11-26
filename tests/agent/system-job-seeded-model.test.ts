import { describe, expect, it } from "vitest";
import { isOnSeededSystemJobModel } from "../../src/gateway/services/jobs/executors/AgentJobExecutor.js";

describe("isOnSeededSystemJobModel", () => {
  it("matches Sleep Cycle and Wiki Writer on their seeded Claude default", () => {
    expect(isOnSeededSystemJobModel("Papr Sleep Cycle", "anthropic", "claude-sonnet-5-5")).toBe(true);
    expect(isOnSeededSystemJobModel("Wiki Writer", "anthropic", "claude-sonnet-5-5")).toBe(true);
    expect(isOnSeededSystemJobModel("Papr Sleep Cycle", undefined, undefined)).toBe(true);
  });

  it("leaves a model the user picked alone", () => {
    expect(isOnSeededSystemJobModel("Papr Sleep Cycle", "openai", "gpt-5.5")).toBe(false);
    expect(isOnSeededSystemJobModel("Wiki Writer", "anthropic", "claude-opus-5-5")).toBe(false);
  });

  it("ignores other jobs", () => {
    expect(isOnSeededSystemJobModel("GTM Audit Scorer", "anthropic", "claude-sonnet-5-5")).toBe(false);
  });
});
