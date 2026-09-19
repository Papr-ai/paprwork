import { describe, expect, it } from "vitest";
import {
  isSendGenerationCurrent,
  nextSendGeneration,
} from "../ui/utils/agentSendLifecycle.js";

describe("agentSendLifecycle", () => {
  it("bumps generation and marks prior send stale after preempt", () => {
    const gens = new Map<string, number>();
    const first = nextSendGeneration(gens, "chat-1");
    expect(isSendGenerationCurrent(gens, "chat-1", first)).toBe(true);

    const second = nextSendGeneration(gens, "chat-1");
    expect(isSendGenerationCurrent(gens, "chat-1", first)).toBe(false);
    expect(isSendGenerationCurrent(gens, "chat-1", second)).toBe(true);
  });
});
