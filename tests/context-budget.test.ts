import { describe, expect, it } from "vitest";
import {
  computeHistoryTokenBudget,
  isContextLengthError,
  resolveModelContextWindow,
} from "../src/gateway/services/agent/contextBudget.js";

describe("contextBudget", () => {
  it("resolves Groq model context windows", () => {
    expect(resolveModelContextWindow("groq", "qwen/qwen3-32b")).toBe(131_072);
  });

  it("computes history budget after tools and output reserve", () => {
    const budget = computeHistoryTokenBudget({
      provider: "groq",
      modelId: "qwen/qwen3-32b",
      toolTokenEstimate: 20_000,
      maxOutputTokens: 16_000,
    });
    // floor(131072 * 0.85) - 20000 - 16000 = 75411
    expect(budget).toBe(75_411);
  });

  it("detects Groq context length errors", () => {
    expect(
      isContextLengthError(
        "API error (400): Please reduce the length of the messages or completion.",
      ),
    ).toBe(true);
    expect(isContextLengthError("context_length_exceeded")).toBe(true);
    expect(isContextLengthError("rate limit exceeded")).toBe(false);
  });
});
