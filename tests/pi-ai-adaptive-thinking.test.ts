import { describe, expect, it } from "vitest";
import {
  augmentPiAiAnthropicStreamOptions,
  buildAdaptiveThinkingOnPayload,
  mapPiAiReasoningToAnthropicEffort,
  requiresPiAiAdaptiveThinkingOverride,
} from "../src/gateway/services/providers/piAiAnthropicAdaptiveThinking.js";

describe("piAiAnthropicAdaptiveThinking", () => {
  it("detects Fable 5, Opus 5, and Sonnet 5 as override models", () => {
    expect(requiresPiAiAdaptiveThinkingOverride("claude-fable-5")).toBe(true);
    expect(requiresPiAiAdaptiveThinkingOverride("claude-opus-5")).toBe(true);
    expect(requiresPiAiAdaptiveThinkingOverride("claude-opus-4-8")).toBe(true);
    expect(requiresPiAiAdaptiveThinkingOverride("claude-sonnet-5")).toBe(true);
    expect(requiresPiAiAdaptiveThinkingOverride("claude-sonnet-4-6")).toBe(
      false,
    );
  });

  it("maps xhigh to max for frontier adaptive models", () => {
    expect(
      mapPiAiReasoningToAnthropicEffort("xhigh", "claude-fable-5"),
    ).toBe("max");
    expect(
      mapPiAiReasoningToAnthropicEffort("xhigh", "claude-sonnet-4-6"),
    ).toBe("high");
  });

  it("patches payload to adaptive summarized thinking", async () => {
    const onPayload = buildAdaptiveThinkingOnPayload(
      "claude-fable-5",
      "medium",
    );
    expect(onPayload).toBeDefined();

    const patched = await onPayload!(
      {
        model: "claude-fable-5",
        max_tokens: 8192,
        messages: [],
        thinking: { type: "enabled", budget_tokens: 8192 },
      },
      { id: "claude-fable-5" },
    );

    expect(patched?.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect(patched?.output_config).toEqual({ effort: "medium" });
  });

  it("adds onPayload only for override models", () => {
    const base = {
      apiKey: "test",
      sessionId: "chat-1",
      reasoning: "medium" as const,
    };

    const fableOpts = augmentPiAiAnthropicStreamOptions(
      "claude-fable-5",
      "medium",
      base,
    );
    expect(fableOpts.onPayload).toBeDefined();

    const sonnetOpts = augmentPiAiAnthropicStreamOptions(
      "claude-sonnet-4-6",
      "medium",
      base,
    );
    expect(sonnetOpts.onPayload).toBeUndefined();
  });

  it("reports a Claude Code version new enough for Opus 5 on OAuth", () => {
    const opts = augmentPiAiAnthropicStreamOptions(
      "claude-opus-5",
      "medium",
      {
        apiKey: "sk-ant-oat01-test",
        sessionId: "chat-1",
        reasoning: "medium",
      },
    );
    expect(opts.headers?.["user-agent"]).toBe("claude-cli/2.1.226");
  });

  it("does not spoof Claude Code headers for direct API keys", () => {
    const opts = augmentPiAiAnthropicStreamOptions(
      "claude-opus-5",
      "medium",
      {
        apiKey: "sk-ant-api03-test",
        sessionId: "chat-1",
        reasoning: "medium",
      },
    );
    expect(opts.headers).toBeUndefined();
  });
});
