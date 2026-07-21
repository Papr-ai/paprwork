import { describe, expect, it } from "vitest";
import {
  computeHistoryTokenBudget,
  GEMINI_HISTORY_TOKEN_CAP,
  isContextLengthError,
  resolveModelContextWindow,
  resolveSummarizeHistoryTokenThreshold,
  shouldForceGeminiResummarize,
} from "../src/gateway/services/agent/contextBudget.js";

describe("contextBudget", () => {
  it("resolves Groq model context windows", () => {
    expect(resolveModelContextWindow("groq", "qwen/qwen3-32b")).toBe(131_072);
  });

  it("resolves Moonshot Kimi K3 context window", () => {
    expect(resolveModelContextWindow("moonshot", "kimi-k3")).toBe(1_048_576);
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

  it("caps Gemini history budget at 150K regardless of 1M window", () => {
    const budget = computeHistoryTokenBudget({
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      toolTokenEstimate: 70_323,
      maxOutputTokens: 16_000,
    });
    expect(budget).toBe(GEMINI_HISTORY_TOKEN_CAP);
  });

  it("uses 150K summarize threshold for Gemini", () => {
    expect(resolveSummarizeHistoryTokenThreshold("google")).toBe(150_000);
    expect(resolveSummarizeHistoryTokenThreshold("openai")).toBe(40_000);
  });

  it("forces Gemini re-summarize when history exceeds cap", () => {
    expect(shouldForceGeminiResummarize("google", 149_999)).toBe(false);
    expect(shouldForceGeminiResummarize("google", 150_000)).toBe(true);
    expect(shouldForceGeminiResummarize("openai", 200_000)).toBe(false);
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
